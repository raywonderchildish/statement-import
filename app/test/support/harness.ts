import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createLogger, FileTooLargeError, ImportEngine,
  type FileStore, type Http, type HttpRequest, type HttpResponse, type KeyValueStore, type UploadRequest,
} from '../../src/import';

export const FIXTURES = resolve(__dirname, '../../../mobile-engineer-kit/fixtures');
export const fixture = (name: string): string => join(FIXTURES, name);

// ------------------------------------------------------------------ the mock

export interface MockStats {
  createRequests: number;
  newJobs: number;
  duplicateHits: number;
  acceptedBytes: number;
  deleteRequests: number;
}

export interface MockState {
  mode: string;
  stats: MockStats;
  jobs: Array<{ jobId: string; status: string; revision: number; sha256: string; bytes: number }>;
}

export type Scenario = 'happy' | 'lost_ack' | 'stale_status' | 'delete_failure';

export interface Mock {
  baseUrl: string;
  reset(): Promise<void>;
  scenario(mode: Scenario): Promise<void>;
  state(): Promise<MockState>;
  stop(): Promise<void>;
}

export async function startMock(): Promise<Mock> {
  const directory = await mkdtemp(join(tmpdir(), 'mock-state-'));
  const child: ChildProcess = spawn(
    process.execPath,
    [resolve(__dirname, 'run-mock.mjs'), join(directory, 'state.json')],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/PORT=(\d+)/);
      if (match) resolvePort(Number(match[1]));
    });
    child.once('exit', code => rejectPort(new Error(`mock exited early with code ${code}`)));
    child.once('error', rejectPort);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = async (path: string, body?: unknown): Promise<void> => {
    const response = await fetch(baseUrl + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  };
  return {
    baseUrl,
    reset: () => post('/__test/reset'),
    scenario: mode => post('/__test/scenario', { mode }),
    state: async () => (await (await fetch(`${baseUrl}/__test/state`)).json()) as MockState,
    stop: async () => {
      child.removeAllListeners('exit');
      const exited = new Promise(done => child.once('exit', done));
      child.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ adapters

export type JournalEntry =
  | { kind: 'store.set'; value: string }
  | { kind: 'store.remove' }
  | { kind: 'http'; method: string; path: string; headers: Record<string, string> };

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  /** When true every write rejects, as a full or broken device store would. */
  failWrites = false;
  constructor(private readonly journal: JournalEntry[]) {}
  async getItem(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error('storage write failed');
    this.journal.push({ kind: 'store.set', value });
    this.data.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.journal.push({ kind: 'store.remove' });
    this.data.delete(key);
  }
}

/** Private temp directory on disk; copies are streamed with a hard byte cap. */
export class NodeFiles implements FileStore {
  copies = 0;
  /** Sources the engine reported it was done with, in order. */
  readonly released: string[] = [];
  constructor(readonly privateDirectory: string, private readonly sizeKnown = true) {}

  async size(ref: string): Promise<number | null> {
    if (!this.sizeKnown && !ref.startsWith(this.privateDirectory)) return null;
    try {
      return (await stat(ref)).size;
    } catch {
      return null;
    }
  }

  async readHead(ref: string, length: number): Promise<Uint8Array> {
    const handle = await open(ref, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async copyToPrivate(sourceRef: string, maxBytes: number): Promise<string> {
    this.copies += 1;
    const target = join(this.privateDirectory, `${randomUUID()}.tmp`);
    const input = createReadStream(sourceRef);
    const output = createWriteStream(target);
    let copied = 0;
    try {
      for await (const chunk of input) {
        copied += (chunk as Buffer).length;
        if (copied > maxBytes) throw new FileTooLargeError();
        if (!output.write(chunk)) await new Promise(done => output.once('drain', done));
      }
      await new Promise<void>((done, fail) => output.end((error?: Error | null) => (error ? fail(error) : done())));
      return target;
    } catch (error) {
      input.destroy();
      await new Promise(done => output.end(done));
      await unlink(target).catch(() => {});
      throw error;
    }
  }

  async remove(ref: string): Promise<void> {
    await unlink(ref).catch(() => {});
  }

  async releaseSource(sourceRef: string): Promise<void> {
    this.released.push(sourceRef);
  }

  async listPrivate(): Promise<string[]> {
    return (await readdir(this.privateDirectory)).map(name => join(this.privateDirectory, name));
  }
}

async function send(url: string, init: RequestInit, timeoutMs: number): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Real HTTP over the loopback interface. */
export const nodeHttp: Http = {
  request: (request: HttpRequest) =>
    send(request.url, { method: request.method, headers: request.headers }, request.timeoutMs),
  uploadFile: async (request: UploadRequest) =>
    send(request.url, { method: 'POST', headers: request.headers, body: await readFile(request.fileRef) }, request.timeoutMs),
};

/**
 * Fault injection for one request. Return a response (or throw) to answer instead
 * of the network, or `undefined` to let the request through.
 */
export type Intercept = (entry: Extract<JournalEntry, { kind: 'http' }>) => Promise<HttpResponse | undefined> | HttpResponse | undefined;

function recordingHttp(journal: JournalEntry[], world: World): Http {
  const run = async (method: string, url: string, headers: Record<string, string>, pass: () => Promise<HttpResponse>) => {
    const entry = { kind: 'http' as const, method, path: new URL(url).pathname, headers };
    const injected = world.intercept ? await world.intercept(entry) : undefined;
    if (injected) return injected;
    journal.push(entry);
    return pass();
  };
  return {
    request: request => run(request.method, request.url, request.headers, () => nodeHttp.request(request)),
    uploadFile: request => run('POST', request.url, request.headers, () => nodeHttp.uploadFile(request)),
  };
}

// --------------------------------------------------------------------- world

/** Everything that survives an app relaunch: storage, private files, and what we observed. */
export interface World {
  journal: JournalEntry[];
  store: MemoryStore;
  files: NodeFiles;
  logs: string[];
  intercept: Intercept | null;
  /** HTTP requests that actually reached the mock. */
  requests(method?: string): Array<Extract<JournalEntry, { kind: 'http' }>>;
  cleanup(): Promise<void>;
}

export async function createWorld(options: { sizeKnown?: boolean } = {}): Promise<World> {
  const directory = await mkdtemp(join(tmpdir(), 'import-private-'));
  const journal: JournalEntry[] = [];
  return {
    journal,
    store: new MemoryStore(journal),
    files: new NodeFiles(directory, options.sizeKnown ?? true),
    logs: [],
    intercept: null,
    requests(method) {
      return journal.filter(
        (entry): entry is Extract<JournalEntry, { kind: 'http' }> =>
          entry.kind === 'http' && (method === undefined || entry.method === method),
      );
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** A new engine over the same world is what an app relaunch looks like to the core. */
export function launch(world: World, baseUrl: string): ImportEngine {
  return new ImportEngine({
    baseUrl,
    store: world.store,
    files: world.files,
    http: recordingHttp(world.journal, world),
    newKey: () => randomUUID(),
    log: createLogger(line => world.logs.push(line)),
    requestTimeoutMs: 3000,
    uploadTimeoutMs: 5000,
  });
}
