import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { recordUsage, loadUsage, summarizeUsage, formatUsageReport } from '../src/lib/llm-usage.js';

async function withTempUsageLog(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'opps-llm-usage-test-'));
  const filePath = path.join(dir, 'llm-usage.jsonl');
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('recordUsage / loadUsage', () => {
  it('returns an empty array when the log does not exist yet', async () => {
    await withTempUsageLog(async (filePath) => {
      assert.deepEqual(await loadUsage(filePath), []);
    });
  });

  it('appends a usage record and reads it back', async () => {
    await withTempUsageLog(async (filePath) => {
      await recordUsage({ model: 'gemini-x', promptTokens: 100, candidatesTokens: 20, totalTokens: 120, timestamp: '2026-08-28T10:00:00.000Z' }, filePath);
      const records = await loadUsage(filePath);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], { timestamp: '2026-08-28T10:00:00.000Z', model: 'gemini-x', promptTokens: 100, candidatesTokens: 20, totalTokens: 120 });
    });
  });

  it('appends multiple records across separate calls', async () => {
    await withTempUsageLog(async (filePath) => {
      await recordUsage({ model: 'gemini-x', promptTokens: 100, candidatesTokens: 20, totalTokens: 120, timestamp: '2026-08-28T10:00:00.000Z' }, filePath);
      await recordUsage({ model: 'gemini-x', promptTokens: 50, candidatesTokens: 10, totalTokens: 60, timestamp: '2026-08-28T11:00:00.000Z' }, filePath);
      const records = await loadUsage(filePath);
      assert.equal(records.length, 2);
    });
  });
});

describe('summarizeUsage', () => {
  const now = Date.parse('2026-08-28T12:00:00.000Z');
  const records = [
    { timestamp: '2020-01-01T00:00:00.000Z', promptTokens: 1000, candidatesTokens: 100, totalTokens: 1100 }, // ancient
    { timestamp: '2026-07-15T00:00:00.000Z', promptTokens: 200, candidatesTokens: 20, totalTokens: 220 }, // ~44 days ago -> total only
    { timestamp: '2026-08-05T00:00:00.000Z', promptTokens: 300, candidatesTokens: 30, totalTokens: 330 }, // ~23 days ago -> month, not week
    { timestamp: '2026-08-27T00:00:00.000Z', promptTokens: 400, candidatesTokens: 40, totalTokens: 440 }, // yesterday -> week, not this run
    { timestamp: '2026-08-28T11:30:00.000Z', promptTokens: 50, candidatesTokens: 5, totalTokens: 55 }, // this run
  ];
  const runStartedAt = '2026-08-28T11:00:00.000Z';

  it('buckets "this run" as everything at or after runStartedAt', () => {
    const usage = summarizeUsage(records, runStartedAt, now);
    assert.equal(usage.thisRun.calls, 1);
    assert.equal(usage.thisRun.totalTokens, 55);
  });

  it('buckets "week" as the last 7 days, cumulative (includes this run)', () => {
    const usage = summarizeUsage(records, runStartedAt, now);
    assert.equal(usage.week.calls, 2);
    assert.equal(usage.week.totalTokens, 440 + 55);
  });

  it('buckets "month" as the last 30 days, cumulative (includes week)', () => {
    const usage = summarizeUsage(records, runStartedAt, now);
    assert.equal(usage.month.calls, 3);
    assert.equal(usage.month.totalTokens, 330 + 440 + 55);
  });

  it('buckets "total" as literally everything ever recorded', () => {
    const usage = summarizeUsage(records, runStartedAt, now);
    assert.equal(usage.total.calls, 5);
    assert.equal(usage.total.totalTokens, 1100 + 220 + 330 + 440 + 55);
  });

  function approxEqual(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
  }

  it('prices every record at the pre-2027 tier ($0.75/1M input, $3.75/1M output) when its timestamp is before 2027-01-01', () => {
    const usage = summarizeUsage(records, runStartedAt, now);
    // this run: 50 prompt tokens + 5 candidate tokens
    approxEqual(usage.thisRun.cost, (50 / 1_000_000) * 0.75 + (5 / 1_000_000) * 3.75);
    // total: sum of all 5 records' individual costs at the same tier
    const expectedTotal = [
      [1000, 100],
      [200, 20],
      [300, 30],
      [400, 40],
      [50, 5],
    ].reduce((sum, [input, output]) => sum + (input / 1_000_000) * 0.75 + (output / 1_000_000) * 3.75, 0);
    approxEqual(usage.total.cost, expectedTotal);
  });

  it('prices a record at the post-2027 tier ($1.50/1M input, $7.50/1M output) when its own timestamp is on/after 2027-01-01', () => {
    const futureRecords = [
      { timestamp: '2026-12-31T23:59:59.000Z', promptTokens: 1000, candidatesTokens: 100, totalTokens: 1100 }, // old tier
      { timestamp: '2027-01-01T00:00:00.000Z', promptTokens: 1000, candidatesTokens: 100, totalTokens: 1100 }, // new tier
    ];
    const usage = summarizeUsage(futureRecords, '2027-01-01T00:00:00.000Z', Date.parse('2027-01-01T01:00:00.000Z'));
    // thisRun only includes the second (new-tier) record
    approxEqual(usage.thisRun.cost, (1000 / 1_000_000) * 1.5 + (100 / 1_000_000) * 7.5);
    // total includes both, each priced at ITS OWN tier, not today's tier applied retroactively
    const oldTierCost = (1000 / 1_000_000) * 0.75 + (100 / 1_000_000) * 3.75;
    const newTierCost = (1000 / 1_000_000) * 1.5 + (100 / 1_000_000) * 7.5;
    approxEqual(usage.total.cost, oldTierCost + newTierCost);
  });
});

describe('formatUsageReport', () => {
  it('shows token counts and a $ cost figure for every bucket', () => {
    const usage = {
      thisRun: { calls: 1, promptTokens: 50, candidatesTokens: 5, totalTokens: 55, cost: 0.00005625 },
      week: { calls: 2, promptTokens: 450, candidatesTokens: 45, totalTokens: 495, cost: 0.0005 },
      month: { calls: 3, promptTokens: 750, candidatesTokens: 75, totalTokens: 825, cost: 0.0008 },
      total: { calls: 5, promptTokens: 1950, candidatesTokens: 195, totalTokens: 2145, cost: 0.0022 },
    };
    const report = formatUsageReport(usage);
    assert.ok(report.includes('Цей прогін: 1 запит(ів), 55 токенів (~$0.0001)'));
    assert.ok(report.includes('Загалом: 5 запит(ів), 2145 токенів (~$0.0022)'));
  });
});
