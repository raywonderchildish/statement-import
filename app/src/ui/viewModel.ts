import type { ErrorCode, ImportRecord, RejectionReason, Snapshot } from '../import';

/**
 * Which screen a snapshot maps to. Kept free of React so the "what do we claim
 * to the user" rules can be tested directly.
 */
export type Screen =
  | { kind: 'empty' }
  | { kind: 'sending' }
  | { kind: 'uncertain'; canRetry: boolean }
  | { kind: 'rejected' }
  | { kind: 'missing' }
  | { kind: 'progress'; status: 'queued' | 'processing' }
  | { kind: 'loadingReport' }
  | { kind: 'ready' }
  | { kind: 'deleting' }
  | { kind: 'deleted' };

export function screenFor(snapshot: Snapshot): Screen {
  const { record, result } = snapshot;
  if (!record) return { kind: 'empty' };
  switch (record.phase) {
    case 'sending':
      return { kind: 'sending' };
    case 'uncertain':
      return { kind: 'uncertain', canRetry: true };
    case 'rejected':
      return { kind: 'rejected' };
    case 'missing':
      return { kind: 'missing' };
    case 'tracking':
      break;
  }
  switch (record.status) {
    case 'deleted':
      return { kind: 'deleted' }; // only ever set from a server answer saying "deleted"
    case 'deleting':
      return { kind: 'deleting' };
    case 'ready':
      return result ? { kind: 'ready' } : { kind: 'loadingReport' };
    case 'processing':
      return { kind: 'progress', status: 'processing' };
    default:
      return { kind: 'progress', status: 'queued' };
  }
}

/** True while the UI should keep asking the server for the job's state. */
export function needsPolling(snapshot: Snapshot): boolean {
  const kind = screenFor(snapshot).kind;
  return kind === 'progress' || kind === 'loadingReport' || kind === 'deleting';
}

/** A delete attempt did not get through; the server still holds the import. */
export function deleteFailed(record: ImportRecord | null): boolean {
  return record !== null && record.deletePhase === 'failed' && record.status !== 'deleting' && record.status !== 'deleted';
}

export const TEXT = {
  rejection: {
    too_large: 'Файл больше 10 МБ. Выберите выписку поменьше.',
    empty: 'Файл пустой.',
    unsupported_content: 'Это не PDF и не CSV-выписка: содержимое файла не соответствует формату.',
    extension_mismatch: 'Расширение файла не совпадает с его содержимым.',
    unreadable: 'Не удалось прочитать файл. Попробуйте выбрать его ещё раз.',
  } satisfies Record<RejectionReason, string>,

  uncertain: {
    network: 'Ответ сервера не получен. Импорт мог быть создан, а мог и нет.',
    server_unavailable: 'Сервер временно недоступен. Импорт мог быть создан, а мог и нет.',
    bad_response: 'Сервер ответил непонятно. Импорт мог быть создан, а мог и нет.',
    conflict: 'Сервер уже знает этот импорт. Нужно запросить его состояние.',
    not_found_yet: 'Сервер пока не видит этот импорт. Можно отправить файл повторно: дубликата не будет.',
    rejected_by_server: 'Сервер отклонил файл.',
    copy_missing: 'Временная копия файла больше недоступна.',
  } satisfies Record<ErrorCode, string>,

  rejected: {
    copy_missing: 'Временная копия файла пропала, повторить отправку нельзя. Выберите файл заново.',
    fallback: 'Сервер отклонил файл. Импорт не создан.',
  },
} as const;

export function uncertainText(code: ErrorCode | null): string {
  return TEXT.uncertain[code ?? 'network'];
}
