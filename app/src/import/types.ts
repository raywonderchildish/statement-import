export type FileFormat = 'pdf' | 'csv';

export type JobStatus = 'queued' | 'processing' | 'ready' | 'deleting' | 'deleted';

export interface RecurringItem {
  id: string;
  merchant: string;
  amountMinor: number;
  cadence: string;
  lastSeen: string;
}

export interface ReadyResult {
  currency: string;
  items: RecurringItem[];
}

/** Server view of a job, as returned by the mock. */
export interface JobView {
  jobId: string;
  status: JobStatus;
  revision: number;
  result: ReadyResult | null;
}

/**
 * sending   - record is persisted, POST is (or was) in flight.
 * uncertain - POST outcome is unknown; a job may or may not exist on the server.
 * tracking  - the server confirmed a job; `status`/`revision` are authoritative.
 * rejected  - the server definitely refused the file; no job exists for this key.
 * missing   - the server no longer knows the job id (for example after a mock reset).
 *             This is NOT a confirmed deletion.
 */
export type Phase = 'sending' | 'uncertain' | 'tracking' | 'rejected' | 'missing';

/**
 * none      - deletion was never requested.
 * requested - DELETE is (or was) in flight; outcome unknown.
 * failed    - DELETE did not get a 202; the job still exists as far as we know.
 * accepted  - the server answered 202. Deletion is confirmed only by status === 'deleted'.
 */
export type DeletePhase = 'none' | 'requested' | 'failed' | 'accepted';

export type ErrorCode =
  | 'network'
  | 'server_unavailable'
  | 'bad_response'
  | 'conflict'
  | 'not_found_yet'
  | 'rejected_by_server'
  | 'copy_missing';

/** The only thing written to persistent storage. No bytes, no server result. */
export interface ImportRecord {
  schema: 1;
  importKey: string;
  fileName: string;
  fileSize: number;
  format: FileFormat;
  /** Private temporary copy; kept only while a re-POST with the same bytes may be needed. */
  copyRef: string | null;
  phase: Phase;
  jobId: string | null;
  status: JobStatus | null;
  revision: number;
  deleteKey: string | null;
  deletePhase: DeletePhase;
  errorCode: ErrorCode | null;
}

export interface Snapshot {
  record: ImportRecord | null;
  /** Held in memory only; re-fetched from the server after a relaunch. */
  result: ReadyResult | null;
}

export type RejectionReason = 'too_large' | 'empty' | 'unsupported_content' | 'extension_mismatch' | 'unreadable';

export interface Candidate {
  copyRef: string;
  name: string;
  size: number;
  format: FileFormat;
}

export type PrepareResult = { ok: true; candidate: Candidate } | { ok: false; reason: RejectionReason };

export type ApplyOutcome =
  | { applied: true }
  | { applied: false; reason: 'stale' | 'terminal' | 'foreign' | 'network' | 'http' | 'bad_response' | 'missing' };

export type RecoverOutcome = 'found' | 'not_found' | 'unreachable';
