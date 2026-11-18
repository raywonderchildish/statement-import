import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { ApplyOutcome, Candidate, ImportEngine, RejectionReason } from '../import';
import { pickStatement } from '../platform/picker';
import { needsPolling } from './viewModel';

const POLL_INTERVAL_MS = 700;

export type Busy = 'restoring' | 'checking' | 'sending' | 'retrying' | 'refreshing' | 'deleting' | 'closing' | null;

/** Connects the engine to React: restore on start, poll while the server is working. */
export function useImport(engine: ImportEngine) {
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [busy, setBusy] = useState<Busy>('restoring');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [rejection, setRejection] = useState<RejectionReason | null>(null);
  const [lastSync, setLastSync] = useState<ApplyOutcome | null>(null);
  const [failure, setFailure] = useState(false);
  const [abandoned, setAbandoned] = useState(false);
  const busyRef = useRef<Busy>('restoring');

  /** Runs one user action at a time; a second tap while busy is ignored. */
  const run = useCallback(async (tag: Exclude<Busy, null>, action: () => Promise<void>, force = false) => {
    if (busyRef.current !== null && !force) return;
    busyRef.current = tag;
    setBusy(tag);
    setFailure(false);
    try {
      await action();
    } catch {
      setFailure(true);
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void run('restoring', async () => void (await engine.restore()), true);
  }, [engine, run]);

  // Poll only while the server is still expected to change the job.
  const polling = busy !== 'restoring' && needsPolling(snapshot);
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    void (async () => {
      while (!cancelled) {
        try {
          const outcome = await engine.refresh();
          if (!cancelled) setLastSync(outcome);
        } catch {
          return; // the operation moved on; the effect restarts if polling is still needed
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, polling, snapshot.record?.importKey]);

  const refresh = useCallback(
    () =>
      run('refreshing', async () => {
        setLastSync(await engine.refresh());
      }),
    [engine, run],
  );

  // Coming back to the foreground: ask the server once instead of trusting a stale screen.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const record = engine.getSnapshot().record;
      if (state === 'active' && record?.phase === 'tracking' && record.status !== 'deleted') void refresh();
    });
    return () => subscription.remove();
  }, [engine, refresh]);

  return {
    snapshot,
    busy,
    candidate,
    rejection,
    lastSync,
    failure,
    abandoned,
    offline: polling && lastSync !== null && !lastSync.applied && lastSync.reason === 'network',

    pick: () =>
      run('checking', async () => {
        setRejection(null);
        setAbandoned(false);
        const picked = await pickStatement();
        if (!picked) return;
        const prepared = await engine.prepare(picked);
        if (prepared.ok) setCandidate(prepared.candidate);
        else setRejection(prepared.reason);
      }),

    cancelCandidate: () =>
      run('closing', async () => {
        if (candidate) await engine.discard(candidate);
        setCandidate(null);
      }),

    send: () =>
      run('sending', async () => {
        if (!candidate) return;
        const accepted = candidate;
        setCandidate(null);
        setLastSync(null);
        await engine.confirm(accepted);
      }),

    retry: () => run('retrying', () => engine.retry()),

    /** Leaves an import whose outcome is unknown; the engine keeps its key for later clean-up. */
    abandon: () =>
      run('closing', async () => {
        setAbandoned((await engine.abandonUncertain()) === 'abandoned');
      }),
    refresh,
    requestDelete: () => run('deleting', () => engine.requestDelete()),

    close: () =>
      run('closing', async () => {
        await engine.dismiss();
        setLastSync(null);
        setRejection(null);
      }),
  };
}

export type ImportController = ReturnType<typeof useImport>;
