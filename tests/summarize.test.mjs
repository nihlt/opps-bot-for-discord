import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeOpportunities, attachSummaries } from '../src/lib/summarize.js';

function opp(id, title) {
  return { id, title, kind: 'event', tags: [], location: '', description: 'desc', link: `https://x.test/${id}` };
}

function fakeFetchOk(jsonText) {
  return async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: jsonText }] } }] }),
    text: async () => jsonText,
  });
}

function fakeFetchHttpError(status) {
  return async () => ({ ok: false, status, text: async () => 'boom' });
}

function fakeFetchThrows() {
  return async () => {
    throw new Error('network unreachable');
  };
}

describe('summarizeOpportunities', () => {
  const items = [opp('a', 'A'), opp('b', 'B')];
  const options = { apiKey: 'k', model: 'm' };

  it('returns a Map of id -> summary for a well-formed JSON response', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([{ id: 'a', summary: 'Summary A' }, { id: 'b', summary: 'Summary B' }]));
    const result = await summarizeOpportunities(items, { ...options, fetchImpl });
    assert.equal(result.get('a'), 'Summary A');
    assert.equal(result.get('b'), 'Summary B');
  });

  it('strips a ```json fence the model wasn\'t supposed to add', async () => {
    const fenced = '```json\n[{"id": "a", "summary": "Fenced summary"}]\n```';
    const fetchImpl = fakeFetchOk(fenced);
    const result = await summarizeOpportunities(items, { ...options, fetchImpl });
    assert.equal(result.get('a'), 'Fenced summary');
  });

  it('returns an empty Map for an empty batch without calling fetch', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
    };
    const result = await summarizeOpportunities([], { ...options, fetchImpl });
    assert.equal(result.size, 0);
    assert.equal(called, false);
  });

  it('throws when apiKey or model is missing', async () => {
    await assert.rejects(() => summarizeOpportunities(items, { apiKey: '', model: 'm', fetchImpl: fakeFetchOk('[]') }));
  });

  it('throws on a non-2xx HTTP response', async () => {
    await assert.rejects(() => summarizeOpportunities(items, { ...options, fetchImpl: fakeFetchHttpError(429) }), /429/);
  });

  it('throws when the model response is not valid JSON', async () => {
    const fetchImpl = fakeFetchOk('not json at all');
    await assert.rejects(() => summarizeOpportunities(items, { ...options, fetchImpl }));
  });

  it('throws when the model response is valid JSON but not an array', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify({ oops: true }));
    await assert.rejects(() => summarizeOpportunities(items, { ...options, fetchImpl }));
  });

  it('propagates a network-level failure', async () => {
    await assert.rejects(() => summarizeOpportunities(items, { ...options, fetchImpl: fakeFetchThrows() }), /network unreachable/);
  });
});

describe('attachSummaries', () => {
  const items = [opp('a', 'A'), opp('b', 'B')];
  const options = { apiKey: 'k', model: 'm' };

  it('attaches .summary to each opportunity on success', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([{ id: 'a', summary: 'Summary A' }, { id: 'b', summary: 'Summary B' }]));
    const result = await attachSummaries(items, { ...options, fetchImpl });
    assert.equal(result[0].summary, 'Summary A');
    assert.equal(result[1].summary, 'Summary B');
  });

  it('sets .summary to null (not the original description) for every item on API failure -- never throws', async () => {
    const result = await attachSummaries(items, { ...options, fetchImpl: fakeFetchHttpError(503) });
    assert.equal(result.length, 2);
    assert.equal(result[0].summary, null);
    assert.equal(result[1].summary, null);
    // Original fields are preserved, just summary added.
    assert.equal(result[0].description, 'desc');
  });

  it('sets .summary to null on a network failure -- never throws', async () => {
    const result = await attachSummaries(items, { ...options, fetchImpl: fakeFetchThrows() });
    assert.equal(result.every((o) => o.summary === null), true);
  });

  it('returns [] for an empty batch', async () => {
    const result = await attachSummaries([], options);
    assert.deepEqual(result, []);
  });

  it('sets .summary to null for an id the model omitted from its response', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([{ id: 'a', summary: 'Summary A' }])); // 'b' missing
    const result = await attachSummaries(items, { ...options, fetchImpl });
    assert.equal(result[0].summary, 'Summary A');
    assert.equal(result[1].summary, null);
  });
});
