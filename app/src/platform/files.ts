import { randomUUID } from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';

import { FileTooLargeError, type FileStore } from '../import';

/**
 * Private temp copies live in the app's cache directory: it is inside the app
 * sandbox, is not part of iCloud/Android backups, and no other app can read it.
 * The OS may purge it under storage pressure; the engine treats a vanished copy
 * as "cannot retry with the same bytes" rather than as an error.
 */
const PRIVATE_DIRECTORY = 'statement-import';
const COPY_CHUNK_BYTES = 256 * 1024;

/**
 * Private copies are referred to by name, not by absolute path: the app's sandbox
 * path changes when the app is updated, and a persisted absolute path would then
 * point nowhere and the copy would look like an orphan.
 */
const PRIVATE_PREFIX = 'private:';

function privateDirectory(): Directory {
  const directory = new Directory(Paths.cache, PRIVATE_DIRECTORY);
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  return directory;
}

/**
 * iOS hands a picked document to the app as a system-made copy in
 * `<sandbox>/tmp/<bundle id>-Inbox/`, whatever the picker options say. Those
 * copies are ours to delete; nothing else ever cleans them up.
 */
function sandboxRootUri(): string {
  return Paths.cache.parentDirectory.parentDirectory.uri;
}

/** On a device the same folder can be spelled with or without the `/private` prefix. */
function normalise(uri: string): string {
  return decodeURI(uri).replace(/^file:\/\/\/private\//, 'file:///');
}

function isInsideSandbox(ref: string): boolean {
  try {
    return normalise(ref).startsWith(normalise(sandboxRootUri()));
  } catch {
    return false;
  }
}

function pickerInboxFiles(): string[] {
  try {
    const temporary = new Directory(sandboxRootUri(), 'tmp');
    if (!temporary.exists) return [];
    return temporary
      .list()
      .filter((entry): entry is Directory => entry instanceof Directory && entry.name.endsWith('-Inbox'))
      .flatMap(inbox => inbox.list())
      .filter(entry => entry instanceof File)
      .map(entry => entry.uri);
  } catch {
    return [];
  }
}

/** Turns an engine ref into a file: one of our named copies, or a picked document URI. */
export function resolveRef(ref: string): File {
  return ref.startsWith(PRIVATE_PREFIX)
    ? new File(privateDirectory(), ref.slice(PRIVATE_PREFIX.length))
    : new File(ref);
}

/** Lets the UI thread breathe between chunks of a long copy. */
const yieldToUi = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export const deviceFiles: FileStore = {
  async size(ref) {
    try {
      const file = resolveRef(ref);
      return file.exists ? file.size : null;
    } catch {
      return null;
    }
  },

  async readHead(ref, length) {
    const handle = resolveRef(ref).open(FileMode.ReadOnly);
    try {
      return await handle.readBytes(length);
    } finally {
      handle.close();
    }
  },

  /**
   * Streams the picked document (Android `content://` or an iOS Files URL) into
   * the private directory in fixed-size chunks. Memory use is one chunk, and the
   * copy stops as soon as the limit is crossed, whatever size the provider claimed.
   */
  async copyToPrivate(sourceRef, maxBytes) {
    const name = `${randomUUID()}.tmp`;
    const target = new File(privateDirectory(), name);
    target.create();
    let input: ReturnType<File['open']> | null = null;
    let output: ReturnType<File['open']> | null = null;
    try {
      input = new File(sourceRef).open(FileMode.ReadOnly);
      output = target.open(FileMode.WriteOnly);
      let copied = 0;
      for (;;) {
        const chunk = await input.readBytes(COPY_CHUNK_BYTES);
        if (chunk.length === 0) break;
        copied += chunk.length;
        if (copied > maxBytes) throw new FileTooLargeError();
        await output.writeBytes(chunk);
        await yieldToUi();
      }
      return PRIVATE_PREFIX + name;
    } catch (error) {
      closeQuietly(output);
      output = null;
      deleteQuietly(target);
      throw error;
    } finally {
      closeQuietly(input);
      closeQuietly(output);
    }
  },

  async remove(ref) {
    deleteQuietly(resolveRef(ref));
  },

  async listPrivate() {
    const copies = privateDirectory()
      .list()
      .map(entry => PRIVATE_PREFIX + entry.name);
    return [...copies, ...pickerInboxFiles()];
  },

  async releaseSource(sourceRef) {
    // Android `content://` documents and anything outside our sandbox are not ours to delete.
    if (sourceRef.startsWith('file:') && isInsideSandbox(sourceRef)) deleteQuietly(new File(sourceRef));
  },
};

function closeQuietly(handle: { close(): void } | null): void {
  try {
    handle?.close();
  } catch {
    // already closed
  }
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // swept on the next start
  }
}
