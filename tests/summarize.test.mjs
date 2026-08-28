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

const fakeGetAccessToken = async () => 'fake-token';

describe('summarizeOpportunities', () => {
  const items = [opp('a', 'A'), opp('b', 'B')];
  const options = { project: 'p', location: 'us-central1', model: 'm', getAccessToken: fakeGetAccessToken };

  it('returns a Map of id -> { summary, relevant, relevanceScore, reason } for a well-formed JSON response', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([
      { id: 'a', summary: 'Summary A', relevant: true, relevanceScore: 80, reason: 'good fit' },
      { id: 'b', summary: 'Summary B', relevant: false, reason: 'charity run, not tech' },
    ]));
    const result = await summarizeOpportunities(items, { ...options, fetchImpl });
    assert.deepEqual(result.get('a'), { summary: 'Summary A', relevant: true, relevanceScore: 80, reason: 'good fit' });
    assert.deepEqual(result.get('b'), { summary: 'Summary B', relevant: false, relevanceScore: null, reason: 'charity run, not tech' });
  });

  it('strips a ```json fence the model wasn\'t supposed to add', async () => {
    const fenced = '```json\n[{"id": "a", "summary": "Fenced summary"}]\n```';
    const fetchImpl = fakeFetchOk(fenced);
    const result = await summarizeOpportunities(items, { ...options, fetchImpl });
    assert.equal(result.get('a').summary, 'Fenced summary');
  });

  it('defaults relevant to true when the model omits it', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([{ id: 'a', summary: 'Summary A' }]));
    const result = await summarizeOpportunities(items, { ...options, fetchImpl });
    assert.equal(result.get('a').relevant, true);
    assert.equal(result.get('a').relevanceScore, null);
  });

  it('defaults relevanceScore to null when non-numeric or missing on a relevant item', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([{ id: 'a', summary: 'Summary A', relevant: true, relevanceScore: 'high' }]));
    const result = await summarizeOpportunities(items, { ...options, fetchImpl });
    assert.equal(result.get('a').relevanceScore, null);
  });

  it('returns an empty Map for an empty batch without calling fetch or auth', async () => {
    let fetchCalled = false;
    let authCalled = false;
    const fetchImpl = async () => {
      fetchCalled = true;
    };
    const getAccessToken = async () => {
      authCalled = true;
      return 'x';
    };
    const result = await summarizeOpportunities([], { ...options, fetchImpl, getAccessToken });
    assert.equal(result.size, 0);
    assert.equal(fetchCalled, false);
    assert.equal(authCalled, false);
  });

  it('throws when project or model is missing', async () => {
    await assert.rejects(() =>
      summarizeOpportunities(items, { ...options, project: '', fetchImpl: fakeFetchOk('[]') }),
    );
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

  it('propagates an access-token/auth failure', async () => {
    const getAccessToken = async () => {
      throw new Error('ADC credentials not found');
    };
    await assert.rejects(
      () => summarizeOpportunities(items, { ...options, getAccessToken, fetchImpl: fakeFetchOk('[]') }),
      /ADC credentials not found/,
    );
  });

  it('sends the access token as a Bearer header, not a query param', async () => {
    let seenUrl;
    let seenAuthHeader;
    const fetchImpl = async (url, init) => {
      seenUrl = url;
      seenAuthHeader = init.headers.Authorization;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) };
    };
    await summarizeOpportunities(items, { ...options, getAccessToken: async () => 'my-token', fetchImpl });
    assert.equal(seenAuthHeader, 'Bearer my-token');
    assert.ok(!seenUrl.includes('my-token'));
  });

  it('calls onUsage with token counts from a successful response\'s usageMetadata', async () => {
    let usage;
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '[]' }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
      }),
    });
    await summarizeOpportunities(items, { ...options, model: 'gemini-x', fetchImpl, onUsage: (u) => { usage = u; } });
    assert.deepEqual(usage, { model: 'gemini-x', promptTokens: 120, candidatesTokens: 30, totalTokens: 150 });
  });

  it('does not call onUsage when the response has no usageMetadata', async () => {
    let called = false;
    const fetchImpl = fakeFetchOk('[]');
    await summarizeOpportunities(items, { ...options, fetchImpl, onUsage: () => { called = true; } });
    assert.equal(called, false);
  });

  it('does not call onUsage for an empty batch (no call made at all)', async () => {
    let called = false;
    await summarizeOpportunities([], { ...options, onUsage: () => { called = true; } });
    assert.equal(called, false);
  });

  it('uses the bare aiplatform host for the "global" location', async () => {
    let seenUrl;
    const fetchImpl = async (url) => {
      seenUrl = url;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) };
    };
    await summarizeOpportunities(items, { ...options, location: 'global', fetchImpl });
    assert.ok(seenUrl.startsWith('https://aiplatform.googleapis.com/'));
  });
});

describe('attachSummaries', () => {
  const items = [opp('a', 'A'), opp('b', 'B')];
  const options = { project: 'p', location: 'us-central1', model: 'm', getAccessToken: fakeGetAccessToken };

  it('attaches .summary/.relevant/.relevanceScore/.relevanceReason to each opportunity on success', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([
      { id: 'a', summary: 'Summary A', relevant: true, relevanceScore: 80, reason: 'good fit' },
      { id: 'b', summary: 'Summary B', relevant: false, reason: 'charity run, not tech' },
    ]));
    const result = await attachSummaries(items, { ...options, fetchImpl });
    assert.equal(result[0].summary, 'Summary A');
    assert.equal(result[0].relevant, true);
    assert.equal(result[0].relevanceScore, 80);
    assert.equal(result[0].relevanceReason, 'good fit');
    assert.equal(result[1].summary, 'Summary B');
    assert.equal(result[1].relevant, false);
    assert.equal(result[1].relevanceReason, 'charity run, not tech');
  });

  it('sets .summary to null and fail-opens .relevant to true (not the original description) for every item on API failure -- never throws', async () => {
    const result = await attachSummaries(items, { ...options, fetchImpl: fakeFetchHttpError(503) });
    assert.equal(result.length, 2);
    assert.equal(result[0].summary, null);
    assert.equal(result[1].summary, null);
    assert.equal(result[0].relevant, true);
    assert.equal(result[0].relevanceScore, null);
    assert.equal(result[0].relevanceReason, null);
    // Original fields are preserved, just summary added.
    assert.equal(result[0].description, 'desc');
  });

  it('sets .summary to null and .relevant to true on a network failure -- never throws', async () => {
    const result = await attachSummaries(items, { ...options, fetchImpl: fakeFetchThrows() });
    assert.equal(result.every((o) => o.summary === null), true);
    assert.equal(result.every((o) => o.relevant === true), true);
  });

  it('calls onFailure with the error on failure, but still never throws', async () => {
    let caught;
    const result = await attachSummaries(items, { ...options, fetchImpl: fakeFetchThrows() }, (error) => {
      caught = error;
    });
    assert.equal(result.every((o) => o.summary === null), true);
    assert.equal(caught.message, 'network unreachable');
  });

  it('does not call onFailure on success', async () => {
    let called = false;
    const fetchImpl = fakeFetchOk(JSON.stringify([{ id: 'a', summary: 'Summary A' }, { id: 'b', summary: 'Summary B' }]));
    await attachSummaries(items, { ...options, fetchImpl }, () => {
      called = true;
    });
    assert.equal(called, false);
  });

  it('sets .summary to null on an auth failure -- never throws', async () => {
    const getAccessToken = async () => {
      throw new Error('ADC credentials not found');
    };
    const result = await attachSummaries(items, { ...options, getAccessToken });
    assert.equal(result.every((o) => o.summary === null), true);
  });

  it('returns [] for an empty batch', async () => {
    const result = await attachSummaries([], options);
    assert.deepEqual(result, []);
  });

  it('sets .summary to null and fail-opens .relevant to true for an id the model omitted from its response', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([{ id: 'a', summary: 'Summary A' }])); // 'b' missing
    const result = await attachSummaries(items, { ...options, fetchImpl });
    assert.equal(result[0].summary, 'Summary A');
    assert.equal(result[1].summary, null);
    assert.equal(result[1].relevant, true);
    assert.equal(result[1].relevanceScore, null);
  });

  it('preserves an explicit relevant: false verdict through to the attached opportunity', async () => {
    const fetchImpl = fakeFetchOk(JSON.stringify([
      { id: 'a', summary: 'Charity run summary', relevant: false, reason: 'sports event, not tech' },
      { id: 'b', summary: 'Summary B', relevant: true, relevanceScore: 70 },
    ]));
    const result = await attachSummaries(items, { ...options, fetchImpl });
    assert.equal(result[0].relevant, false);
    assert.equal(result[0].relevanceReason, 'sports event, not tech');
    assert.equal(result[1].relevant, true);
    assert.equal(result[1].relevanceScore, 70);
  });
});
