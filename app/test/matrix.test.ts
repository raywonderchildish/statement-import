import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ABANDONED_STORAGE_KEY, RECORD_STORAGE_KEY, type ImportEngine, type ImportRecord } from '../src/import';
import { createWorld, fixture, launch, startMock, type Mock, type World } from './support/harness';

jest.setTimeout(30_000);

let mock: Mock;
let world: World;

beforeAll(async () => {
  mock = await startMock();
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(async () => {
  await mock.reset();
  world = await createWorld();
});
afterEach(async () => {
  await world.cleanup();
});

const record = (engine: ImportEngine): ImportRecord => {
  const value = engine.getSnapshot().record;
  if (!value) throw new Error('no record');
  return value;
};

async function startImport(engine: ImportEngine, name: string, ref = fixture(name)): Promise<void> {
  const prepared = await engine.prepare({ ref, name });
  if (!prepared.ok) throw new Error(`fixture rejected: ${prepared.reason}`);
  await engine.confirm(prepared.candidate);
}

const untilReady = (engine: ImportEngine) => engine.pollUntil(current => current.status === 'ready');
const storedRecord = (): ImportRecord => JSON.parse(world.store.data.get(RECORD_STORAGE_KEY) ?? 'null');

describe('happy', () => {
  it.each(['statement.csv', 'statement.pdf'])('%s: real bytes are sent, 202 is not a report, ready shows mock data', async name => {
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, name);

    // 202 only means "queued".
    expect(record(engine)).toMatchObject({ phase: 'tracking', status: 'queued', revision: 1 });
    expect(engine.getSnapshot().result).toBeNull();

    // The mock received exactly the fixture's bytes, once.
    const bytes = await readFile(fixture(name));
    const state = await mock.state();
    expect(state.stats).toMatchObject({ createRequests: 1, newJobs: 1, duplicateHits: 0, acceptedBytes: bytes.length });
    expect(state.jobs[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(world.requests('POST')[0].headers['Content-Type']).toBe('application/octet-stream');

    expect(await untilReady(engine)).toBe(true);
    const { result } = engine.getSnapshot();
    expect(record(engine)).toMatchObject({ status: 'ready', revision: 3 });
    expect(result?.currency).toBe('AUD');
    expect(result?.items.map(item => [item.merchant, item.amountMinor, item.lastSeen])).toEqual([
      ['StreamBeam', 1999, '2026-10-01'],
      ['BrightGrid', 13200, '2026-10-03'],
    ]);
    expect(result?.items.reduce((sum, item) => sum + item.amountMinor, 0)).toBe(15199);

    // The private copy is gone once the server holds the job.
    expect(record(engine).copyRef).toBeNull();
    expect(await world.files.listPrivate()).toEqual([]);
  });

  it('accepts a non-ASCII file name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'picked-'));
    const picked = join(directory, 'выписка за октябрь.csv');
    await copyFile(fixture('statement.csv'), picked);
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'выписка за октябрь.csv', picked);
    expect(record(engine).phase).toBe('tracking');
    expect(world.requests('POST')[0].headers['X-File-Name']).toMatch(/^[\x21-\x7E]+$/);
    await rm(directory, { recursive: true, force: true });
  });
});

describe('persisted key', () => {
  it('stores the key and the operation before the first POST and sends that same key', async () => {
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');

    const firstPost = world.journal.findIndex(entry => entry.kind === 'http' && entry.method === 'POST');
    const firstWrite = world.journal.findIndex(entry => entry.kind === 'store.set');
    expect(firstWrite).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeLessThan(firstPost);

    const written = world.journal[firstWrite];
    const post = world.journal[firstPost];
    if (written.kind !== 'store.set' || post.kind !== 'http') throw new Error('unexpected journal');
    const persisted: ImportRecord = JSON.parse(written.value);
    expect(persisted.phase).toBe('sending');
    expect(persisted.importKey.length).toBeGreaterThanOrEqual(8);
    expect(post.headers['Idempotency-Key']).toBe(persisted.importKey);
    expect(storedRecord().importKey).toBe(persisted.importKey);
  });
});

describe('lost_ack', () => {
  it('retry in the same session finds the job by key: one job, no second POST', async () => {
    await mock.scenario('lost_ack');
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');

    expect(record(engine)).toMatchObject({ phase: 'uncertain', jobId: null, errorCode: 'network' });
    expect(record(engine).copyRef).not.toBeNull(); // bytes kept for a possible re-POST

    await engine.retry();
    expect(record(engine)).toMatchObject({ phase: 'tracking', jobId: 'job-demo-001' });
    expect((await mock.state()).stats).toMatchObject({ createRequests: 1, newJobs: 1 });
    expect(world.requests('POST')).toHaveLength(1);
    expect(await world.files.listPrivate()).toEqual([]);
  });

  it('relaunch recovers the job by the stored key without re-sending the file', async () => {
    await mock.scenario('lost_ack');
    await startImport(launch(world, mock.baseUrl), 'statement.pdf');
    const keyBefore = storedRecord().importKey;

    const relaunched = launch(world, mock.baseUrl);
    await relaunched.restore();

    expect(record(relaunched)).toMatchObject({ phase: 'tracking', jobId: 'job-demo-001', importKey: keyBefore });
    expect((await mock.state()).stats).toMatchObject({ createRequests: 1, newJobs: 1, duplicateHits: 0 });
    expect(world.requests('POST')).toHaveLength(1);
    expect(await untilReady(relaunched)).toBe(true);
    expect(engineTotal(relaunched)).toBe(15199);
  });

  it('when the lookup races and says 404, the re-POST uses the same key and still yields one job', async () => {
    await mock.scenario('lost_ack');
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');

    let lookups = 0;
    world.intercept = entry => {
      if (entry.path.startsWith('/imports/by-key/') && lookups++ === 0) {
        return { status: 404, body: '{"error":"job not found"}' };
      }
      return undefined;
    };
    await engine.retry();

    const posts = world.requests('POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].headers['Idempotency-Key']).toBe(posts[0].headers['Idempotency-Key']);
    expect(record(engine)).toMatchObject({ phase: 'tracking', jobId: 'job-demo-001' });
    expect((await mock.state()).stats).toMatchObject({ createRequests: 2, newJobs: 1, duplicateHits: 1 });
  });
});

describe('relaunch', () => {
  it('does not send the file on its own when the POST never left the device', async () => {
    world.intercept = entry => {
      if (entry.method === 'POST') throw new Error('process killed before the request left');
      return undefined;
    };
    await startImport(launch(world, mock.baseUrl), 'statement.csv');
    world.intercept = null;

    const relaunched = launch(world, mock.baseUrl);
    await relaunched.restore();
    expect(record(relaunched)).toMatchObject({ phase: 'uncertain', errorCode: 'not_found_yet', jobId: null });
    expect((await mock.state()).stats.createRequests).toBe(0);
    expect(await world.files.listPrivate()).toHaveLength(1);

    // Only an explicit retry sends it, with the key stored before the first attempt.
    const key = storedRecord().importKey;
    await relaunched.retry();
    expect(world.requests('POST')[0].headers['Idempotency-Key']).toBe(key);
    expect((await mock.state()).stats).toMatchObject({ createRequests: 1, newJobs: 1 });
  });

  it('shows the current job after a normal relaunch without any POST', async () => {
    const first = launch(world, mock.baseUrl);
    await startImport(first, 'statement.csv');
    await untilReady(first);

    const relaunched = launch(world, mock.baseUrl);
    await relaunched.restore();
    expect(record(relaunched)).toMatchObject({ phase: 'tracking', status: 'ready', revision: 3 });
    expect(engineTotal(relaunched)).toBe(15199);
    expect((await mock.state()).stats).toMatchObject({ createRequests: 1, newJobs: 1, duplicateHits: 0 });
  });

  it('removes a private copy left behind by a crash', async () => {
    await world.files.copyToPrivate(fixture('statement.csv'), 1024);
    expect(await world.files.listPrivate()).toHaveLength(1);
    await launch(world, mock.baseUrl).restore();
    expect(await world.files.listPrivate()).toEqual([]);
  });
});

describe('leaving an uncertain import', () => {
  const offline = () => {
    world.intercept = () => {
      throw new Error('server unreachable');
    };
  };

  it('does not abandon when the server turns out to have the job', async () => {
    await mock.scenario('lost_ack');
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');

    expect(await engine.abandonUncertain()).toBe('recovered');
    expect(record(engine)).toMatchObject({ phase: 'tracking', jobId: 'job-demo-001' });
    expect(world.store.data.has(ABANDONED_STORAGE_KEY)).toBe(false);
  });

  it('keeps the key when the server is unreachable and deletes the server job on later launches', async () => {
    await mock.scenario('lost_ack');
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');
    const key = record(engine).importKey;

    offline();
    expect(await engine.abandonUncertain()).toBe('abandoned');
    expect(engine.getSnapshot().record).toBeNull();
    expect(world.store.data.has(RECORD_STORAGE_KEY)).toBe(false);
    expect(await world.files.listPrivate()).toEqual([]);
    expect(world.store.data.get(ABANDONED_STORAGE_KEY)).toContain(key);
    await expect(engine.abandonUncertain()).rejects.toThrow();

    // Still offline on the next launch: nothing is forgotten.
    await launch(world, mock.baseUrl).restore();
    expect(world.store.data.get(ABANDONED_STORAGE_KEY)).toContain(key);

    // Back online: the job is found by key and a DELETE is sent, but not yet trusted.
    world.intercept = null;
    await mock.scenario('happy');
    await launch(world, mock.baseUrl).restore();
    expect((await mock.state()).stats).toMatchObject({ newJobs: 1, deleteRequests: 1 });
    expect(world.store.data.get(ABANDONED_STORAGE_KEY)).toContain(key);

    // A later launch sees `deleted` from the server and only then drops the key.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await launch(world, mock.baseUrl).restore();
    expect((await mock.state()).jobs[0].status).toBe('deleted');
    expect(world.store.data.has(ABANDONED_STORAGE_KEY)).toBe(false);
    const deletes = world.requests('DELETE');
    expect(new Set(deletes.map(entry => entry.headers['Idempotency-Key'])).size).toBe(1);
  });

  it('drops the key once the server says no such job exists', async () => {
    offline();
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv'); // the POST never left the device
    expect(await engine.abandonUncertain()).toBe('abandoned');

    world.intercept = null;
    await launch(world, mock.baseUrl).restore();
    expect(world.store.data.has(ABANDONED_STORAGE_KEY)).toBe(false);
    expect((await mock.state()).stats).toMatchObject({ createRequests: 0, deleteRequests: 0 });
  });
});

describe('stale_status', () => {
  it('keeps ready/revision 3 when processing/revision 2 arrives afterwards', async () => {
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');
    await mock.scenario('stale_status');

    expect(await engine.refresh()).toEqual({ applied: true });
    expect(record(engine)).toMatchObject({ status: 'ready', revision: 3 });

    // The mock's second GET in this scenario is the older processing/2.
    expect(await engine.refresh()).toEqual({ applied: false, reason: 'stale' });
    expect(record(engine)).toMatchObject({ status: 'ready', revision: 3 });
    expect(engineTotal(engine)).toBe(15199);
    expect(storedRecord()).toMatchObject({ status: 'ready', revision: 3 });
    expect(world.logs.some(line => line.includes('"status_ignored"') && line.includes('"revision":2'))).toBe(true);
  });
});

describe('delete', () => {
  it('202 means deleting; deleted is reported only after a confirming GET', async () => {
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');
    await untilReady(engine);

    await engine.requestDelete();
    expect(record(engine)).toMatchObject({ status: 'deleting', deletePhase: 'accepted' });
    expect(engine.getSnapshot().result).toBeNull();
    await expect(engine.dismiss()).rejects.toThrow();

    expect(await engine.pollUntil(current => current.status === 'deleted')).toBe(true);
    expect(record(engine)).toMatchObject({ status: 'deleted', revision: 5 });
    expect((await mock.state()).jobs[0].status).toBe('deleted');

    await engine.dismiss();
    expect(engine.getSnapshot().record).toBeNull();
    expect(world.store.data.has(RECORD_STORAGE_KEY)).toBe(false);
  });

  it('delete_failure: a 503 never claims deletion; the same key succeeds after switching to happy', async () => {
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');
    await untilReady(engine);
    await mock.scenario('delete_failure');

    await engine.requestDelete();
    expect(record(engine)).toMatchObject({ status: 'ready', deletePhase: 'failed', errorCode: 'server_unavailable' });
    expect(await engine.refresh()).toEqual({ applied: true });
    expect(record(engine).status).toBe('ready');
    expect((await mock.state()).jobs[0].status).toBe('ready');
    const deleteKey = record(engine).deleteKey;
    expect(deleteKey).not.toBeNull();

    // The delete key was stored before the first DELETE and survives a relaunch.
    const relaunched = launch(world, mock.baseUrl);
    await relaunched.restore();
    expect(record(relaunched)).toMatchObject({ status: 'ready', deletePhase: 'failed', deleteKey });

    await mock.scenario('happy');
    await relaunched.requestDelete();
    expect(record(relaunched).status).toBe('deleting');
    expect(await relaunched.pollUntil(current => current.status === 'deleted')).toBe(true);

    const deletes = world.requests('DELETE');
    expect(deletes).toHaveLength(2);
    expect(deletes.map(entry => entry.headers['Idempotency-Key'])).toEqual([deleteKey, deleteKey]);
    const state = await mock.state();
    expect(state.stats.deleteRequests).toBe(2);
    expect(state.jobs[0].status).toBe('deleted');
  });

  it('a late ready answer does not resurrect a deleted job', async () => {
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');
    await untilReady(engine);
    const jobId = record(engine).jobId;

    // Hold one status response in flight while the job gets deleted.
    let release: (() => void) | undefined;
    let held = false;
    world.intercept = async entry => {
      if (entry.method !== 'GET' || held) return undefined;
      held = true;
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return {
        status: 200,
        body: JSON.stringify({ jobId, status: 'ready', revision: 3, currency: 'AUD', items: [] }),
      };
    };
    const late = engine.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));

    await engine.requestDelete();
    expect(await engine.pollUntil(current => current.status === 'deleted')).toBe(true);

    release?.();
    expect(await late).toEqual({ applied: false, reason: 'terminal' });
    expect(record(engine)).toMatchObject({ status: 'deleted', revision: 5 });
    expect(engine.getSnapshot().result).toBeNull();
    expect(storedRecord().status).toBe('deleted');
  });

  it('a job the server no longer knows is reported as missing, not as deleted', async () => {
    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'statement.csv');
    await untilReady(engine);
    await mock.reset();

    expect(await engine.refresh()).toEqual({ applied: false, reason: 'missing' });
    expect(record(engine)).toMatchObject({ phase: 'missing', status: 'ready' });
  });
});

describe('spoofed + oversize', () => {
  it('rejects both files locally: createRequests does not change and no copy remains', async () => {
    const before = (await mock.state()).stats.createRequests;
    const engine = launch(world, mock.baseUrl);

    expect(await engine.prepare({ ref: fixture('spoofed.pdf'), name: 'spoofed.pdf' })).toEqual({
      ok: false, reason: 'unsupported_content',
    });
    expect(await engine.prepare({ ref: fixture('oversize.csv'), name: 'oversize.csv' })).toEqual({
      ok: false, reason: 'too_large',
    });

    expect((await mock.state()).stats.createRequests).toBe(before);
    expect(world.requests()).toEqual([]);
    expect(world.files.copies).toBe(1); // the oversize file was refused from metadata, never copied
    expect(await world.files.listPrivate()).toEqual([]);
    expect(engine.getSnapshot().record).toBeNull();
    expect(world.store.data.size).toBe(0);
  });

  it('stops copying an oversize file whose size is unknown up front', async () => {
    const blind = await createWorld({ sizeKnown: false });
    const engine = launch(blind, mock.baseUrl);
    expect(await engine.prepare({ ref: fixture('oversize.csv'), name: 'oversize.csv' })).toEqual({
      ok: false, reason: 'too_large',
    });
    expect(await blind.files.listPrivate()).toEqual([]);
    expect((await mock.state()).stats.createRequests).toBe(0);
    await blind.cleanup();
  });

  it('releases the picked source in every outcome so a system-made copy never lingers', async () => {
    const engine = launch(world, mock.baseUrl);
    for (const name of ['spoofed.pdf', 'oversize.csv']) {
      await engine.prepare({ ref: fixture(name), name });
    }
    const accepted = await engine.prepare({ ref: fixture('statement.csv'), name: 'statement.csv' });
    expect(accepted.ok).toBe(true);
    expect(world.files.released).toEqual(['spoofed.pdf', 'oversize.csv', 'statement.csv'].map(fixture));

    const blind = await createWorld({ sizeKnown: false });
    await launch(blind, mock.baseUrl).prepare({ ref: fixture('oversize.csv'), name: 'oversize.csv' });
    expect(blind.files.released).toEqual([fixture('oversize.csv')]);
    await blind.cleanup();
    if (accepted.ok) await engine.discard(accepted.candidate);
  });

  it('rejects a real CSV renamed to .pdf', async () => {
    const engine = launch(world, mock.baseUrl);
    expect(await engine.prepare({ ref: fixture('statement.csv'), name: 'statement.pdf' })).toEqual({
      ok: false, reason: 'extension_mismatch',
    });
    expect(await world.files.listPrivate()).toEqual([]);
  });
});

describe('privacy', () => {
  it('logs contain no file name, key, or merchant description', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'picked-'));
    const picked = join(directory, 'secret-family-budget.csv');
    await copyFile(fixture('statement.csv'), picked);

    const engine = launch(world, mock.baseUrl);
    await startImport(engine, 'secret-family-budget.csv', picked);
    await untilReady(engine);
    const { importKey } = record(engine);
    await engine.requestDelete();
    await engine.pollUntil(current => current.status === 'deleted');
    const { deleteKey } = record(engine);

    const output = world.logs.join('\n');
    expect(world.logs.length).toBeGreaterThan(5);
    for (const secret of ['secret-family-budget', importKey, deleteKey ?? '', 'StreamBeam', 'BrightGrid', '2026-09-01']) {
      expect(secret).not.toBe('');
      expect(output).not.toContain(secret);
    }
    // Merchant data is never written to persistent storage either.
    const stored = world.journal.flatMap(entry => (entry.kind === 'store.set' ? [entry.value] : [])).join('\n');
    expect(stored).not.toContain('StreamBeam');
    await rm(directory, { recursive: true, force: true });
  });
});

function engineTotal(engine: ImportEngine): number | undefined {
  return engine.getSnapshot().result?.items.reduce((sum, item) => sum + item.amountMinor, 0);
}
