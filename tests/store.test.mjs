import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadEvents, appendNewEvents, filterNewOpportunities } from '../src/lib/store.js';

async function withTempStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'opps-store-test-'));
  const filePath = path.join(dir, 'events.jsonl');
  try {
    await run(filePath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeEvent(id) {
  return { id, sourceId: 'test', title: `Event ${id}`, link: `https://example.com/${id}` };
}

describe('store', () => {
  it('returns an empty array when the file does not exist yet', async () => {
    await withTempStore(async (filePath) => {
      assert.deepEqual(await loadEvents(filePath), []);
    });
  });

  it('appends new events and returns only the ones actually written', async () => {
    await withTempStore(async (filePath) => {
      const events = [fakeEvent('a'), fakeEvent('b'), fakeEvent('c')];
      const written = await appendNewEvents(events, filePath);
      assert.deepEqual(written.map((e) => e.id).sort(), ['a', 'b', 'c']);

      const stored = await loadEvents(filePath);
      assert.equal(stored.length, 3);
      assert.deepEqual(stored.map((e) => e.id).sort(), ['a', 'b', 'c']);
    });
  });

  it('dedupes by id: re-appending an existing id is a no-op', async () => {
    await withTempStore(async (filePath) => {
      await appendNewEvents([fakeEvent('a'), fakeEvent('b')], filePath);

      const secondWrite = await appendNewEvents([fakeEvent('a'), fakeEvent('c')], filePath);
      assert.deepEqual(secondWrite.map((e) => e.id), ['c']);

      const stored = await loadEvents(filePath);
      assert.equal(stored.length, 3);
      assert.deepEqual(stored.map((e) => e.id).sort(), ['a', 'b', 'c']);
    });
  });

  it('stamps firstSeenAt on a new event that does not already have one', async () => {
    await withTempStore(async (filePath) => {
      const [written] = await appendNewEvents([fakeEvent('a')], filePath);
      assert.ok(written.firstSeenAt, 'expected firstSeenAt to be stamped');
      assert.ok(!Number.isNaN(Date.parse(written.firstSeenAt)));

      const [stored] = await loadEvents(filePath);
      assert.equal(stored.firstSeenAt, written.firstSeenAt);
    });
  });

  it('preserves an existing firstSeenAt (e.g. from the notion source) instead of overwriting it', async () => {
    await withTempStore(async (filePath) => {
      const event = { ...fakeEvent('a'), firstSeenAt: '2020-01-01T00:00:00.000Z' };
      const [written] = await appendNewEvents([event], filePath);
      assert.equal(written.firstSeenAt, '2020-01-01T00:00:00.000Z');
    });
  });

  it('appending only already-known ids does not touch the file', async () => {
    await withTempStore(async (filePath) => {
      await appendNewEvents([fakeEvent('a')], filePath);
      const result = await appendNewEvents([fakeEvent('a')], filePath);
      assert.deepEqual(result, []);
      assert.equal((await loadEvents(filePath)).length, 1);
    });
  });

  it('filterNewOpportunities returns only ids not already in the store, without writing anything', async () => {
    await withTempStore(async (filePath) => {
      await appendNewEvents([fakeEvent('a'), fakeEvent('b')], filePath);

      const candidates = await filterNewOpportunities([fakeEvent('a'), fakeEvent('c'), fakeEvent('d')], filePath);
      assert.deepEqual(candidates.map((e) => e.id), ['c', 'd']);

      // Nothing written -- store still only has the original 2.
      assert.equal((await loadEvents(filePath)).length, 2);
    });
  });

  it('lets a caller attach a field (e.g. .summary) to filterNewOpportunities results before persisting', async () => {
    await withTempStore(async (filePath) => {
      const candidates = await filterNewOpportunities([fakeEvent('a')], filePath);
      const withSummary = candidates.map((e) => ({ ...e, summary: 'Concrete benefit.' }));
      const [written] = await appendNewEvents(withSummary, filePath);
      assert.equal(written.summary, 'Concrete benefit.');

      const [stored] = await loadEvents(filePath);
      assert.equal(stored.summary, 'Concrete benefit.');
    });
  });

  it('leaves no leftover .tmp file after a successful write', async () => {
    await withTempStore(async (filePath, dir) => {
      await appendNewEvents([fakeEvent('a')], filePath);
      const files = await readdir(dir);
      assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
    });
  });
});
