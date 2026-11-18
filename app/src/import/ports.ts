/** Durable key-value storage (AsyncStorage on device, in-memory in tests). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Thrown by `copyToPrivate` when the source turns out to exceed `maxBytes` while streaming. */
export class FileTooLargeError extends Error {
  constructor() {
    super('file exceeds the size limit');
    this.name = 'FileTooLargeError';
  }
}

/**
 * File access. `ref` is opaque to the core: a content:// URI, a security-scoped
 * iOS URL, or a path inside the app's private directory.
 */
export interface FileStore {
  /** Size in bytes from metadata, without reading the file. `null` if unknown or missing. */
  size(ref: string): Promise<number | null>;
  /** At most `length` bytes from the start of the file. Must not read the whole file. */
  readHead(ref: string, length: number): Promise<Uint8Array>;
  /**
   * Streams the source into the app's private temp directory and returns the new ref.
   * Must stop and throw `FileTooLargeError` as soon as more than `maxBytes` were copied.
   */
  copyToPrivate(sourceRef: string, maxBytes: number): Promise<string>;
  /** Idempotent: removing a missing file is not an error. */
  remove(ref: string): Promise<void>;
  /**
   * Every temp file the app owns on disk: its private copies and anything the
   * system picker dropped into the app sandbox (used to sweep orphans after a crash).
   */
  listPrivate(): Promise<string[]>;
  /**
   * Called once the engine is done reading a picked source. Must delete the source
   * if it is a temporary copy inside the app sandbox (iOS puts picked documents in
   * `tmp/<bundle>-Inbox`), and must do nothing for a document that lives elsewhere.
   */
  releaseSource(sourceRef: string): Promise<void>;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface UploadRequest {
  url: string;
  headers: Record<string, string>;
  /** The file's raw bytes are the request body. */
  fileRef: string;
  timeoutMs: number;
}

/**
 * Network access. Both methods resolve for any HTTP status and reject only when
 * no response was received (connection dropped, timeout).
 */
export interface Http {
  request(request: HttpRequest): Promise<HttpResponse>;
  uploadFile(request: UploadRequest): Promise<HttpResponse>;
}
