/**
 * Privacy-safe diagnostics. Only the fields below can be logged, and only as
 * numbers, booleans or short machine tokens. File names, file bytes, idempotency
 * keys and merchant descriptions have no field here, so they cannot leak by accident.
 */
export type LogEvent =
  | 'file_rejected'
  | 'file_accepted'
  | 'record_persisted'
  | 'create_sent'
  | 'create_uncertain'
  | 'create_rejected'
  | 'job_confirmed'
  | 'recover_by_key'
  | 'status_applied'
  | 'status_ignored'
  | 'job_missing'
  | 'delete_sent'
  | 'delete_failed'
  | 'delete_accepted'
  | 'delete_confirmed'
  | 'copy_removed'
  | 'orphan_copy_removed'
  | 'record_cleared'
  | 'import_abandoned'
  | 'abandoned_cleanup';

export interface LogFields {
  phase?: string;
  status?: string;
  revision?: number;
  httpStatus?: number;
  reason?: string;
  format?: string;
  sizeBytes?: number;
  jobId?: string;
}

export type Logger = (event: LogEvent, fields?: LogFields) => void;

const ALLOWED_FIELDS: ReadonlyArray<keyof LogFields> = [
  'phase', 'status', 'revision', 'httpStatus', 'reason', 'format', 'sizeBytes', 'jobId',
];
const TOKEN = /^[a-z0-9_-]{1,40}$/;

/** Runtime guard on top of the types: drops unknown keys and anything that is not a token. */
export function sanitizeFields(fields: LogFields | undefined): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  if (!fields) return safe;
  const source = fields as Record<string, unknown>;
  for (const name of ALLOWED_FIELDS) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) safe[name] = value;
    else if (typeof value === 'string' && TOKEN.test(value)) safe[name] = value;
  }
  return safe;
}

export function createLogger(sink: (line: string) => void): Logger {
  return (event, fields) => sink(JSON.stringify({ event, ...sanitizeFields(fields) }));
}

export const silentLogger: Logger = () => {};
