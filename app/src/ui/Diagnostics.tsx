import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import type { ApplyOutcome } from '../import';
import { API_BASE_URL } from '../platform/engine';
import { ActionButton, Body, Card, Field, Notice } from './components';

const MODES = ['happy', 'lost_ack', 'stale_status', 'delete_failure'] as const;

interface MockState {
  mode: string;
  stats: { createRequests: number; newJobs: number; duplicateHits: number; acceptedBytes: number; deleteRequests: number };
  jobs: Array<{ jobId: string; status: string; revision: number }>;
}

const IGNORED: Record<string, string> = {
  stale: 'проигнорирован: ревизия старее уже показанной',
  terminal: 'проигнорирован: импорт уже удалён',
  foreign: 'проигнорирован: относится к другому импорту',
  network: 'не получен: нет связи',
  http: 'не принят: неожиданный код ответа',
  bad_response: 'не принят: непонятный ответ',
  missing: 'сервер не знает этот импорт',
};

/**
 * Reviewer tooling for the kit's mock: switch its scenario and read its counters.
 * It talks only to the mock's /__test routes and is not part of the product flow.
 */
export function Diagnostics({ lastSync }: { lastSync: ApplyOutcome | null }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<MockState | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);

  const call = useCallback(async (path?: string, body?: unknown) => {
    if (path) setBusy(true);
    try {
      if (path) {
        const response = await fetch(API_BASE_URL + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
        if (!response.ok) throw new Error('mock refused');
      }
      setState((await (await fetch(`${API_BASE_URL}/__test/state`)).json()) as MockState);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    } finally {
      setBusy(false);
    }
  }, []);

  // Counters are re-read while the panel is open so they always match the mock.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void call(), 1500);
    return () => clearInterval(timer);
  }, [open, call]);

  if (!open) {
    return (
      <ActionButton
        title="Диагностика mock"
        kind="secondary"
        onPress={() => {
          setOpen(true);
          void call();
        }}
      />
    );
  }

  return (
    <Card>
      <Body muted>Диагностика локального mock. Только для проверки, не часть продукта.</Body>
      <Field label="Адрес" value={API_BASE_URL} />
      {unreachable && <Notice tone="error">Mock недоступен. Запустите npm start в наборе; на Android — adb reverse tcp:8787 tcp:8787.</Notice>}
      {state && (
        <>
          <Field label="Сценарий" value={state.mode} />
          <Field
            label="Счётчики"
            value={
              `createRequests=${state.stats.createRequests}  newJobs=${state.stats.newJobs}  ` +
              `duplicateHits=${state.stats.duplicateHits}  deleteRequests=${state.stats.deleteRequests}`
            }
          />
          <Field
            label="Задания на сервере"
            value={state.jobs.length === 0 ? 'нет' : state.jobs.map(job => `${job.jobId}: ${job.status}/${job.revision}`).join('\n')}
          />
        </>
      )}
      <Field
        label="Последний ответ о статусе"
        value={lastSync === null ? 'ещё не было' : lastSync.applied ? 'применён' : IGNORED[lastSync.reason] ?? lastSync.reason}
      />
      <View style={{ gap: 8 }}>
        {MODES.map(mode => (
          <ActionButton
            key={mode}
            title={state?.mode === mode ? `● ${mode}` : mode}
            kind="secondary"
            disabled={busy}
            onPress={() => void call('/__test/scenario', { mode })}
          />
        ))}
        <ActionButton title="Обновить счётчики" kind="secondary" disabled={busy} onPress={() => void call()} />
        <ActionButton title="Сбросить mock" kind="danger" disabled={busy} onPress={() => void call('/__test/reset')} />
        <ActionButton title="Скрыть" kind="secondary" onPress={() => setOpen(false)} />
      </View>
    </Card>
  );
}
