import type { FileFormat, RejectionReason } from './types';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** How many leading bytes are needed to recognise a supported file. */
export const HEAD_BYTES = 24;

const PDF_MAGIC = ascii('%PDF-');
const CSV_HEADER = ascii('date,description,amount\n');
const CARRIAGE_RETURN = 13;

function ascii(text: string): number[] {
  return Array.from(text, character => character.charCodeAt(0));
}

function startsWith(bytes: ArrayLike<number>, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * Decides the format from the leading bytes only. Mirrors the mock's own check
 * (`%PDF-` signature, or the fixed CSV header within the first 24 bytes with CRs
 * dropped) so the client never sends a file the server would refuse.
 */
export function detectFormat(head: Uint8Array): FileFormat | null {
  if (startsWith(head, PDF_MAGIC)) return 'pdf';
  const window = Array.from(head.subarray(0, HEAD_BYTES)).filter(byte => byte !== CARRIAGE_RETURN);
  if (startsWith(window, CSV_HEADER)) return 'csv';
  return null;
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export type Verdict = { ok: true; format: FileFormat } | { ok: false; reason: RejectionReason };

/**
 * Content is authoritative. The extension is only a consistency check: a file
 * whose name claims one supported format while its bytes are the other is refused.
 */
export function validateFile(input: { name: string; size: number; head: Uint8Array }): Verdict {
  if (input.size > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
  if (input.size === 0) return { ok: false, reason: 'empty' };
  const format = detectFormat(input.head);
  if (!format) return { ok: false, reason: 'unsupported_content' };
  const extension = extensionOf(input.name);
  if ((extension === 'pdf' || extension === 'csv') && extension !== format) {
    return { ok: false, reason: 'extension_mismatch' };
  }
  return { ok: true, format };
}

/**
 * HTTP header values must be visible ASCII. Other names are percent-encoded; a
 * name that still does not fit the server's 1-255 limit is replaced by a neutral one.
 */
export function encodeFileNameHeader(name: string, format: FileFormat): string {
  const encoded = /^[\x21-\x7E][\x20-\x7E]*$/.test(name) ? name.trimEnd() : encodeURIComponent(name);
  return encoded.length >= 1 && encoded.length <= 255 ? encoded : `statement.${format}`;
}
