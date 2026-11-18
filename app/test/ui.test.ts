import type { ImportRecord, ReadyResult } from '../src/import';
import { formatDate, formatMoney, formatSize, monthlyTotal } from '../src/ui/format';
import { deleteFailed, needsPolling, screenFor } from '../src/ui/viewModel';

const base: ImportRecord = {
  schema: 1, importKey: 'key-12345678', fileName: 'statement.csv', fileSize: 112, format: 'csv', copyRef: null,
  phase: 'tracking', jobId: 'job-demo-001', status: 'ready', revision: 3,
  deleteKey: null, deletePhase: 'none', errorCode: null,
};
const result: ReadyResult = {
  currency: 'AUD',
  items: [
    { id: 'rec-001', merchant: 'StreamBeam', amountMinor: 1999, cadence: 'monthly', lastSeen: '2026-10-01' },
    { id: 'rec-002', merchant: 'BrightGrid', amountMinor: 13200, cadence: 'monthly', lastSeen: '2026-10-03' },
  ],
};
const kind = (record: ImportRecord | null, withResult = false) =>
  screenFor({ record, result: withResult ? result : null }).kind;

describe('screenFor: what the UI is allowed to claim', () => {
  it('shows nothing as ready before the server says ready', () => {
    expect(kind(null)).toBe('empty');
    expect(kind({ ...base, phase: 'sending', jobId: null, status: null, revision: 0 })).toBe('sending');
    expect(kind({ ...base, status: 'queued', revision: 1 })).toBe('progress');
    expect(kind({ ...base, status: 'processing', revision: 2 })).toBe('progress');
    expect(kind(base, true)).toBe('ready');
    expect(kind(base, false)).toBe('loadingReport');
  });

  it('never shows deleted for an accepted, failed, or unknown deletion', () => {
    expect(kind({ ...base, status: 'deleting', revision: 4, deletePhase: 'accepted' })).toBe('deleting');
    expect(kind({ ...base, deletePhase: 'accepted' }, true)).toBe('ready');
    expect(kind({ ...base, deletePhase: 'failed' }, true)).toBe('ready');
    expect(kind({ ...base, deletePhase: 'requested' }, true)).toBe('ready');
    expect(kind({ ...base, phase: 'missing' })).toBe('missing');
    expect(kind({ ...base, status: 'deleted', revision: 5, deletePhase: 'accepted' })).toBe('deleted');
  });

  it('keeps an uncertain create distinct from an error and from success', () => {
    expect(kind({ ...base, phase: 'uncertain', jobId: null, status: null, revision: 0, errorCode: 'network' })).toBe('uncertain');
    expect(kind({ ...base, phase: 'rejected', jobId: null, status: null, errorCode: 'rejected_by_server' })).toBe('rejected');
  });

  it('polls only while the server is expected to change the job', () => {
    expect(needsPolling({ record: { ...base, status: 'queued' }, result: null })).toBe(true);
    expect(needsPolling({ record: { ...base, status: 'deleting' }, result: null })).toBe(true);
    expect(needsPolling({ record: base, result })).toBe(false);
    expect(needsPolling({ record: { ...base, status: 'deleted' }, result: null })).toBe(false);
    expect(needsPolling({ record: { ...base, phase: 'uncertain' }, result: null })).toBe(false);
  });

  it('flags a failed delete only while the job still exists', () => {
    expect(deleteFailed({ ...base, deletePhase: 'failed' })).toBe(true);
    expect(deleteFailed({ ...base, deletePhase: 'failed', status: 'deleted' })).toBe(false);
    expect(deleteFailed(base)).toBe(false);
  });
});

describe('formatting', () => {
  it('formats money from minor units without floats', () => {
    expect(formatMoney(1999, 'AUD')).toBe('19.99 AUD');
    expect(formatMoney(13200, 'AUD')).toBe('132.00 AUD');
    expect(formatMoney(5, 'AUD')).toBe('0.05 AUD');
    expect(formatMoney(monthlyTotal(result.items), result.currency)).toBe('151.99 AUD');
  });

  it('formats dates and sizes', () => {
    expect(formatDate('2026-10-01')).toBe('1 октября 2026');
    expect(formatDate('soon')).toBe('soon');
    expect(formatSize(112)).toBe('112 Б');
    expect(formatSize(33882)).toBe('33.1 КБ');
    expect(formatSize(10 * 1024 * 1024)).toBe('10.0 МБ');
  });
});
