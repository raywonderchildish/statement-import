import { silentLogger, type Logger } from './logger';
import { FileTooLargeError, type FileStore, type Http, type HttpResponse, type KeyValueStore } from './ports';
import { parseJobView, parseRecord } from './protocol';
import type {
  ApplyOutcome, Candidate, ErrorCode, ImportRecord, JobView, PrepareResult, ReadyResult, RecoverOutcome, Snapshot,
} from './types';
import { encodeFileNameHeader, HEAD_BYTES, MAX_FILE_BYTES, validateFile } from './validate';

export const RECORD_STORAGE_KEY = 'statement-import/record/v1';
export const ABANDONED_STORAGE_KEY = 'statement-import/abandoned/v1';

/** An import the user walked away from while its outcome was unknown. */
interface AbandonedImport {
  importKey: string;
  /** Fixed up front so a later clean-up DELETE is idempotent across launches. */
  deleteKey: string;
}

export interface EngineDeps {
  baseUrl: string;
  store: KeyValueStore;
  files: FileStore;
  http: Http;
  /** Returns a fresh random idempotency key (8-128 characters). */
  newKey: () => string;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

export class EngineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineStateError';
  }
}

/**
 * One import operation at a time, from confirmation to server-confirmed deletion.
 *
 * Invariants:
 *  - The idempotency key and the record are durably stored BEFORE the first POST,
 *    and the delete key BEFORE the first DELETE. Retries reuse them.
 *  - Nothing re-sends the file on its own. After a relaunch only GETs are issued;
 *    a re-POST happens only from `retry()`, with the same key and the same bytes.
 *  - A server answer is applied only if it belongs to the current operation, the
 *    job is not already `deleted`, and its revision is not older than the one seen.
 *  - `deleted` is set only from a server answer saying `deleted`. A 202 on DELETE
 *    means `deleting`, a 404 means `missing`; neither is reported as deleted.
 *  - Leaving an uncertain import never drops its key: the key is kept in a small
 *    list and later launches look the job up and ask the server to delete it.
 */
export class ImportEngine {
  private record: ImportRecord | null = null;
  private result: ReadyResult | null = null;
  private snapshot: Snapshot = { record: null, result: null };
  private readonly listeners = new Set<() => void>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.log ?? silentLogger;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 10_000;
    this.uploadTimeoutMs = deps.uploadTimeoutMs ?? 60_000;
  }

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // ---------------------------------------------------------------- startup

  /**
   * Loads the persisted operation and brings it up to date using GET requests only.
   * Never POSTs: an interrupted or lost create is looked up by its key.
   */
  async restore(): Promise<Snapshot> {
    this.record = parseRecord(await this.deps.store.getItem(RECORD_STORAGE_KEY));
    this.result = null;
    this.publish();
    await this.sweepOrphanCopies();
    await this.cleanUpAbandoned();
    const record = this.record;
    if (!record) return this.snapshot;
    const key = record.importKey;

    if (record.phase === 'sending' || record.phase === 'uncertain') {
      await this.mutate(key, draft => {
        draft.phase = 'uncertain';
      });
      await this.recoverByKey(key);
    } else if (record.phase === 'tracking') {
      await this.dropCopy(key);
      if (record.deletePhase === 'requested') {
        // The app died while DELETE was in flight: outcome unknown until the server says so.
        await this.mutate(key, draft => {
          draft.deletePhase = 'failed';
        });
      }
      if (record.status !== 'deleted') await this.refresh();
    } else {
      await this.dropCopy(key);
    }
    return this.snapshot;
  }

  // ------------------------------------------------------- local validation

  /**
   * Copies the picked file into private storage and validates it by content.
   * No network request is made here; a rejected file leaves no copy behind.
   */
  async prepare(source: { ref: string; name: string }): Promise<PrepareResult> {
    if (this.record) throw new EngineStateError('another import is in progress');
    const { files } = this.deps;

    let declaredSize: number | null = null;
    try {
      declaredSize = await files.size(source.ref);
    } catch {
      declaredSize = null;
    }
    if (declaredSize !== null && declaredSize > MAX_FILE_BYTES) {
      await this.releaseSource(source.ref);
      return this.reject('too_large');
    }

    let copyRef: string;
    try {
      copyRef = await files.copyToPrivate(source.ref, MAX_FILE_BYTES);
    } catch (error) {
      return this.reject(error instanceof FileTooLargeError ? 'too_large' : 'unreadable');
    } finally {
      // From here on only our own size-capped copy is used.
      await this.releaseSource(source.ref);
    }

    try {
      const size = await files.size(copyRef);
      if (size === null) throw new Error('copy has no size');
      const head = await files.readHead(copyRef, HEAD_BYTES);
      const verdict = validateFile({ name: source.name, size, head });
      if (!verdict.ok) {
        await this.removeFile(copyRef);
        return this.reject(verdict.reason);
      }
      this.log('file_accepted', { format: verdict.format, sizeBytes: size });
      return { ok: true, candidate: { copyRef, name: source.name, size, format: verdict.format } };
    } catch {
      await this.removeFile(copyRef);
      return this.reject('unreadable');
    }
  }

  /** The user backed out of the confirmation screen. */
  async discard(candidate: Candidate): Promise<void> {
    await this.removeFile(candidate.copyRef);
  }

  // ----------------------------------------------------------------- create

  /** Persists the key and the record, then sends the bytes. */
  async confirm(candidate: Candidate): Promise<void> {
    if (this.record) throw new EngineStateError('another import is in progress');
    const importKey = this.deps.newKey();
    this.record = {
      schema: 1,
      importKey,
      fileName: candidate.name,
      fileSize: candidate.size,
      format: candidate.format,
      copyRef: candidate.copyRef,
      phase: 'sending',
      jobId: null,
      status: null,
      revision: 0,
      deleteKey: null,
      deletePhase: 'none',
      errorCode: null,
    };
    this.result = null;
    this.publish();
    await this.persist(); // must be durable before the first byte leaves the device
    this.log('record_persisted', { phase: 'sending' });
    await this.send(importKey);
  }

  /**
   * Resolves an uncertain create. Looks the job up by key first; only if the
   * server does not know it, re-sends the same bytes with the same key.
   */
  async retry(): Promise<void> {
    const record = this.record;
    if (!record || record.phase !== 'uncertain') throw new EngineStateError('nothing to retry');
    const key = record.importKey;
    const outcome = await this.recoverByKey(key);
    if (outcome !== 'not_found') return;

    const current = this.current(key);
    if (!current) return;
    const copyRef = current.copyRef;
    const copySize = copyRef === null ? null : await this.deps.files.size(copyRef).catch(() => null);
    if (copyRef === null || copySize !== current.fileSize) {
      // Without the original bytes the same key cannot be reused safely.
      await this.mutate(key, draft => {
        draft.phase = 'rejected';
        draft.errorCode = 'copy_missing';
      });
      await this.dropCopy(key);
      return;
    }
    await this.mutate(key, draft => {
      draft.phase = 'sending';
      draft.errorCode = null;
    });
    await this.send(key);
  }

  /**
   * Lets the user leave an import whose outcome is still unknown.
   *
   * One last lookup is made first: if the server has the job, nothing is
   * abandoned and the normal job screen (with its delete button) takes over.
   * Otherwise the key is remembered for later clean-up, the private copy is
   * removed and the screen is freed. The caller must tell the user that a
   * server-side import may exist and that its deletion cannot be confirmed now.
   */
  async abandonUncertain(): Promise<'recovered' | 'abandoned'> {
    const record = this.record;
    if (!record || record.phase !== 'uncertain') throw new EngineStateError('nothing to abandon');
    const key = record.importKey;
    if ((await this.recoverByKey(key)) === 'found') return 'recovered';
    if (!this.current(key)) return 'abandoned';

    const abandoned = await this.readAbandoned();
    abandoned.push({ importKey: key, deleteKey: this.deps.newKey() });
    await this.deps.store.setItem(ABANDONED_STORAGE_KEY, JSON.stringify(abandoned)); // before the record goes
    this.log('import_abandoned');
    await this.clearRecord();
    return 'abandoned';
  }

  // ----------------------------------------------------------------- status

  /** One authoritative GET for the current job. */
  async refresh(): Promise<ApplyOutcome> {
    const record = this.record;
    if (!record || record.phase !== 'tracking' || record.jobId === null) {
      throw new EngineStateError('no job to refresh');
    }
    if (record.status === 'deleted') return { applied: false, reason: 'terminal' };
    const key = record.importKey;
    let response: HttpResponse;
    try {
      response = await this.deps.http.request({
        method: 'GET',
        url: `${this.deps.baseUrl}/imports/${encodeURIComponent(record.jobId)}`,
        headers: {},
        timeoutMs: this.requestTimeoutMs,
      });
    } catch {
      return { applied: false, reason: 'network' };
    }
    if (response.status === 404) return this.markMissing(key);
    if (response.status !== 200) return { applied: false, reason: 'http' };
    const view = parseJobView(response.body);
    if (!view) return { applied: false, reason: 'bad_response' };
    return this.applyView(key, view);
  }

  /** Polls until `done` holds for the current record or the time budget runs out. */
  async pollUntil(
    done: (record: ImportRecord) => boolean,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<boolean> {
    const intervalMs = options.intervalMs ?? 300;
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    for (;;) {
      const record = this.record;
      if (!record) return false;
      if (done(record)) return true;
      if (record.phase !== 'tracking' || record.status === 'deleted') return false;
      if (Date.now() >= deadline) return false;
      await this.refresh();
      const after = this.record;
      if (after && done(after)) return true;
      await this.sleep(intervalMs);
    }
  }

  // ----------------------------------------------------------------- delete

  /**
   * Asks the server to delete the job. Safe to call again after a failure: the
   * same delete key is reused. Resolves once the request was answered or failed;
   * deletion itself is confirmed later by `refresh()` returning `deleted`.
   */
  async requestDelete(): Promise<void> {
    const record = this.record;
    if (!record || record.phase !== 'tracking' || record.jobId === null) {
      throw new EngineStateError('no job to delete');
    }
    if (record.status === 'deleted') return;
    const key = record.importKey;
    const jobId = record.jobId;
    const deleteKey = record.deleteKey ?? this.deps.newKey();
    await this.mutate(key, draft => {
      draft.deleteKey = deleteKey;
      draft.deletePhase = 'requested';
      draft.errorCode = null;
    });
    this.log('delete_sent', { jobId });

    let response: HttpResponse;
    try {
      response = await this.deps.http.request({
        method: 'DELETE',
        url: `${this.deps.baseUrl}/imports/${encodeURIComponent(jobId)}`,
        headers: { 'Idempotency-Key': deleteKey },
        timeoutMs: this.requestTimeoutMs,
      });
    } catch {
      await this.failDelete(key, 'network');
      return;
    }
    if (response.status === 404) {
      await this.markMissing(key);
      return;
    }
    const view = response.status === 202 ? parseJobView(response.body) : null;
    if (!view) {
      this.log('delete_failed', { httpStatus: response.status });
      await this.failDelete(key, response.status === 202 ? 'bad_response' : 'server_unavailable');
      return;
    }
    this.log('delete_accepted', { httpStatus: 202 });
    await this.mutate(key, draft => {
      if (draft.status !== 'deleted') draft.deletePhase = 'accepted';
    });
    await this.applyView(key, view);
  }

  /**
   * Forgets a finished operation locally. Allowed only when no server data can
   * be left behind unknowingly: deletion confirmed, upload rejected, or the
   * server no longer knows the job.
   */
  async dismiss(): Promise<void> {
    const record = this.record;
    if (!record) return;
    const finished = record.status === 'deleted' || record.phase === 'rejected' || record.phase === 'missing';
    if (!finished) throw new EngineStateError('the import still exists or its outcome is unknown');
    await this.clearRecord();
  }

  // ---------------------------------------------------------------- private

  private async clearRecord(): Promise<void> {
    const copyRef = this.record?.copyRef ?? null;
    if (copyRef !== null) await this.removeFile(copyRef);
    this.record = null;
    this.result = null;
    this.publish();
    await this.persist();
    this.log('record_cleared');
  }

  private async readAbandoned(): Promise<AbandonedImport[]> {
    try {
      const value: unknown = JSON.parse((await this.deps.store.getItem(ABANDONED_STORAGE_KEY)) ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry): entry is AbandonedImport =>
          typeof entry === 'object' && entry !== null &&
          typeof (entry as AbandonedImport).importKey === 'string' &&
          typeof (entry as AbandonedImport).deleteKey === 'string',
      );
    } catch {
      return [];
    }
  }

  /**
   * Best-effort clean-up of abandoned imports, one pass per launch, GET first.
   * An entry is dropped only when the server says there is no such job or that
   * it is deleted; a job that exists gets a DELETE and is re-checked next launch.
   */
  private async cleanUpAbandoned(): Promise<void> {
    const abandoned = await this.readAbandoned();
    if (abandoned.length === 0) return;
    const remaining: AbandonedImport[] = [];
    for (const entry of abandoned) {
      let settled = false;
      try {
        const lookup = await this.deps.http.request({
          method: 'GET',
          url: `${this.deps.baseUrl}/imports/by-key/${encodeURIComponent(entry.importKey)}`,
          headers: {},
          timeoutMs: this.requestTimeoutMs,
        });
        const view = lookup.status === 200 ? parseJobView(lookup.body) : null;
        if (lookup.status === 404 || view?.status === 'deleted') {
          settled = true;
        } else if (view && view.status !== 'deleting') {
          await this.deps.http.request({
            method: 'DELETE',
            url: `${this.deps.baseUrl}/imports/${encodeURIComponent(view.jobId)}`,
            headers: { 'Idempotency-Key': entry.deleteKey },
            timeoutMs: this.requestTimeoutMs,
          });
        }
      } catch {
        // unreachable: try again on the next launch
      }
      this.log('abandoned_cleanup', { reason: settled ? 'settled' : 'pending' });
      if (!settled) remaining.push(entry);
    }
    try {
      if (remaining.length === 0) await this.deps.store.removeItem(ABANDONED_STORAGE_KEY);
      else await this.deps.store.setItem(ABANDONED_STORAGE_KEY, JSON.stringify(remaining));
    } catch {
      // the list stays as it was; clean-up repeats next launch
    }
  }

  private async send(key: string): Promise<void> {
    const record = this.current(key);
    if (!record || record.copyRef === null) return;
    this.log('create_sent', { format: record.format, sizeBytes: record.fileSize });
    let response: HttpResponse;
    try {
      response = await this.deps.http.uploadFile({
        url: `${this.deps.baseUrl}/imports`,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Idempotency-Key': record.importKey,
          'X-File-Name': encodeFileNameHeader(record.fileName, record.format),
        },
        fileRef: record.copyRef,
        timeoutMs: this.uploadTimeoutMs,
      });
    } catch {
      // No response at all: the server may or may not have created the job.
      await this.markUncertain(key, 'network');
      return;
    }

    if (response.status === 202) {
      const view = parseJobView(response.body);
      if (!view) {
        await this.markUncertain(key, 'bad_response', response.status);
        return;
      }
      await this.confirmJob(key, view);
      return;
    }
    if (response.status === 409) {
      // The key already belongs to a job on the server; find it instead of guessing.
      await this.markUncertain(key, 'conflict', response.status);
      return;
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      await this.markUncertain(key, 'server_unavailable', response.status);
      return;
    }
    if (this.current(key)?.phase !== 'sending') return;
    this.log('create_rejected', { httpStatus: response.status });
    await this.mutate(key, draft => {
      draft.phase = 'rejected';
      draft.errorCode = 'rejected_by_server';
    });
    await this.dropCopy(key);
  }

  private async recoverByKey(key: string): Promise<RecoverOutcome> {
    if (!this.current(key)) return 'unreachable';
    let response: HttpResponse;
    try {
      response = await this.deps.http.request({
        method: 'GET',
        url: `${this.deps.baseUrl}/imports/by-key/${encodeURIComponent(key)}`,
        headers: {},
        timeoutMs: this.requestTimeoutMs,
      });
    } catch {
      this.log('recover_by_key', { reason: 'network' });
      await this.setError(key, 'network');
      return 'unreachable';
    }
    this.log('recover_by_key', { httpStatus: response.status });
    if (response.status === 404) {
      await this.setError(key, 'not_found_yet');
      return 'not_found';
    }
    const view = response.status === 200 ? parseJobView(response.body) : null;
    if (!view) {
      await this.setError(key, response.status === 200 ? 'bad_response' : 'server_unavailable');
      return 'unreachable';
    }
    await this.confirmJob(key, view);
    return 'found';
  }

  /** The server acknowledged a job for our key: remember it, then drop the bytes. */
  private async confirmJob(key: string, view: JobView): Promise<void> {
    const record = this.current(key);
    if (!record) return;
    // A late create/lookup answer must not reopen an operation that already moved on.
    if (record.phase === 'sending' || record.phase === 'uncertain') {
      await this.mutate(key, draft => {
        draft.phase = 'tracking';
        draft.jobId = view.jobId;
        draft.errorCode = null;
      });
      this.log('job_confirmed', { jobId: view.jobId });
    }
    await this.applyView(key, view);
    await this.dropCopy(key);
  }

  private async applyView(key: string, view: JobView): Promise<ApplyOutcome> {
    const record = this.current(key);
    if (!record || record.jobId !== view.jobId) return this.ignore('foreign', view);
    if (record.status === 'deleted') return this.ignore('terminal', view);
    if (view.revision < record.revision) return this.ignore('stale', view);

    this.result = view.status === 'ready' ? view.result : null;
    await this.mutate(key, draft => {
      draft.status = view.status;
      draft.revision = view.revision;
      if (view.status === 'deleting' || view.status === 'deleted') draft.deletePhase = 'accepted';
    });
    this.log('status_applied', { status: view.status, revision: view.revision });
    if (view.status === 'deleted') this.log('delete_confirmed', { revision: view.revision });
    return { applied: true };
  }

  private ignore(reason: 'stale' | 'terminal' | 'foreign', view: JobView): ApplyOutcome {
    this.log('status_ignored', { reason, status: view.status, revision: view.revision });
    return { applied: false, reason };
  }

  private async markMissing(key: string): Promise<ApplyOutcome> {
    this.result = null;
    await this.mutate(key, draft => {
      if (draft.status === 'deleted') return;
      draft.phase = 'missing';
      if (draft.deletePhase === 'requested') draft.deletePhase = 'failed';
    });
    this.log('job_missing');
    return { applied: false, reason: 'missing' };
  }

  private async markUncertain(key: string, errorCode: ErrorCode, httpStatus?: number): Promise<void> {
    this.log('create_uncertain', httpStatus === undefined ? { reason: errorCode } : { reason: errorCode, httpStatus });
    await this.mutate(key, draft => {
      if (draft.phase !== 'sending') return; // already resolved by a lookup
      draft.phase = 'uncertain';
      draft.errorCode = errorCode;
    });
  }

  private async failDelete(key: string, errorCode: ErrorCode): Promise<void> {
    await this.mutate(key, draft => {
      if (draft.status === 'deleting' || draft.status === 'deleted') return;
      draft.deletePhase = 'failed';
      draft.errorCode = errorCode;
    });
  }

  private async setError(key: string, errorCode: ErrorCode): Promise<void> {
    await this.mutate(key, draft => {
      draft.errorCode = errorCode;
    });
  }

  private async dropCopy(key: string): Promise<void> {
    const record = this.current(key);
    if (!record || record.copyRef === null) return;
    await this.removeFile(record.copyRef);
    await this.mutate(key, draft => {
      draft.copyRef = null;
    });
    this.log('copy_removed');
  }

  private async sweepOrphanCopies(): Promise<void> {
    let refs: string[];
    try {
      refs = await this.deps.files.listPrivate();
    } catch {
      return;
    }
    const keep = this.record?.copyRef ?? null;
    for (const ref of refs) {
      if (ref === keep) continue;
      await this.removeFile(ref);
      this.log('orphan_copy_removed');
    }
  }

  private async releaseSource(ref: string): Promise<void> {
    try {
      await this.deps.files.releaseSource(ref);
    } catch {
      // Retried by the orphan sweep on the next start.
    }
  }

  private async removeFile(ref: string): Promise<void> {
    try {
      await this.deps.files.remove(ref);
    } catch {
      // Retried by the orphan sweep on the next start.
    }
  }

  private reject(reason: Extract<PrepareResult, { ok: false }>['reason']): PrepareResult {
    this.log('file_rejected', { reason });
    return { ok: false, reason };
  }

  /** The record, but only if it still belongs to the operation identified by `key`. */
  private current(key: string): ImportRecord | null {
    return this.record && this.record.importKey === key ? this.record : null;
  }

  /** Applies a change to the current operation's record and persists it. */
  private async mutate(key: string, change: (draft: ImportRecord) => void): Promise<boolean> {
    const record = this.current(key);
    if (!record) return false;
    const draft = { ...record };
    change(draft);
    this.record = draft;
    this.publish();
    await this.persist();
    return true;
  }

  private publish(): void {
    this.snapshot = { record: this.record, result: this.result };
    for (const listener of this.listeners) listener();
  }

  /** Writes are serialised so an older state can never overwrite a newer one. */
  private persist(): Promise<void> {
    const write = this.writeChain.then(() => {
      const record = this.record;
      return record
        ? this.deps.store.setItem(RECORD_STORAGE_KEY, JSON.stringify(record))
        : this.deps.store.removeItem(RECORD_STORAGE_KEY);
    });
    this.writeChain = write.catch(() => {});
    return write;
  }
}
