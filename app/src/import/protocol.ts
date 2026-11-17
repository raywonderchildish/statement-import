import type { ImportRecord, JobStatus, JobView, RecurringItem } from './types';

const STATUSES: ReadonlyArray<JobStatus> = ['queued', 'processing', 'ready', 'deleting', 'deleted'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseItem(value: unknown): RecurringItem | null {
  if (!isObject(value)) return null;
  const { id, merchant, amountMinor, cadence, lastSeen } = value;
  if (typeof id !== 'string' || typeof merchant !== 'string' || typeof cadence !== 'string') return null;
  if (typeof lastSeen !== 'string' || typeof amountMinor !== 'number' || !Number.isInteger(amountMinor)) return null;
  return { id, merchant, amountMinor, cadence, lastSeen };
}

/** Strict parse of a job response. Anything unexpected yields `null`, never a guess. */
export function parseJobView(body: string): JobView | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { jobId, status, revision } = value;
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  if (typeof status !== 'string' || !STATUSES.includes(status as JobStatus)) return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null;
  if (status !== 'ready') return { jobId, status: status as JobStatus, revision, result: null };
  if (typeof value.currency !== 'string' || !Array.isArray(value.items)) return null;
  const items: RecurringItem[] = [];
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (!item) return null;
    items.push(item);
  }
  return { jobId, status: 'ready', revision, result: { currency: value.currency, items } };
}

/** Parses the persisted record; a corrupt or foreign value is treated as absent. */
export function parseRecord(raw: string | null): ImportRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || value.schema !== 1) return null;
  if (typeof value.importKey !== 'string' || typeof value.phase !== 'string') return null;
  if (typeof value.revision !== 'number' || typeof value.fileName !== 'string') return null;
  return value as unknown as ImportRecord;
}
