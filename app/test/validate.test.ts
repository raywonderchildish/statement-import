import { readFile } from 'node:fs/promises';

import {
  detectFormat, encodeFileNameHeader, HEAD_BYTES, MAX_FILE_BYTES, parseJobView, sanitizeFields, validateFile,
  type LogFields,
} from '../src/import';
import { fixture } from './support/harness';

const head = async (name: string): Promise<Uint8Array> =>
  new Uint8Array((await readFile(fixture(name))).subarray(0, HEAD_BYTES));

describe('detectFormat', () => {
  it('recognises the kit fixtures by content', async () => {
    expect(detectFormat(await head('statement.pdf'))).toBe('pdf');
    expect(detectFormat(await head('statement.csv'))).toBe('csv');
    expect(detectFormat(await head('spoofed.pdf'))).toBeNull();
    expect(detectFormat(new Uint8Array())).toBeNull();
  });
});

describe('validateFile', () => {
  const csv = new TextEncoder().encode('date,description,amount\n');

  it('applies the 10 MiB limit inclusively', () => {
    expect(validateFile({ name: 'a.csv', size: MAX_FILE_BYTES, head: csv })).toEqual({ ok: true, format: 'csv' });
    expect(validateFile({ name: 'a.csv', size: MAX_FILE_BYTES + 1, head: csv })).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects empty files and trusts content over a missing extension', () => {
    expect(validateFile({ name: 'a.csv', size: 0, head: new Uint8Array() })).toEqual({ ok: false, reason: 'empty' });
    expect(validateFile({ name: 'export', size: 24, head: csv })).toEqual({ ok: true, format: 'csv' });
  });
});

describe('encodeFileNameHeader', () => {
  it('keeps ASCII, encodes the rest, and falls back when too long', () => {
    expect(encodeFileNameHeader('statement.csv', 'csv')).toBe('statement.csv');
    expect(encodeFileNameHeader('выписка.pdf', 'pdf')).toBe(encodeURIComponent('выписка.pdf'));
    expect(encodeFileNameHeader('я'.repeat(100) + '.pdf', 'pdf')).toBe('statement.pdf');
  });
});

describe('parseJobView', () => {
  it('refuses malformed answers instead of guessing', () => {
    expect(parseJobView('not json')).toBeNull();
    expect(parseJobView('{"jobId":"j","status":"done","revision":1}')).toBeNull();
    expect(parseJobView('{"jobId":"j","status":"ready","revision":3}')).toBeNull();
    expect(parseJobView('{"jobId":"j","status":"queued","revision":1}')).toEqual({
      jobId: 'j', status: 'queued', revision: 1, result: null,
    });
  });
});

describe('sanitizeFields', () => {
  it('drops unknown keys and free text', () => {
    const fields = { status: 'ready', revision: 3, reason: 'Family Budget.pdf', fileName: 'x.pdf' } as LogFields;
    expect(sanitizeFields(fields)).toEqual({ status: 'ready', revision: 3 });
  });
});
