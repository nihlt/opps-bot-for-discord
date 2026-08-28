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
});

describe('formatUsageReport', () => {
  const usage = {
    thisRun: { calls: 1, promptTokens: 50, candidatesTokens: 5, totalTokens: 55 },
    week: { calls: 2, promptTokens: 450, candidatesTokens: 45, totalTokens: 495 },
    month: { calls: 3, promptTokens: 750, candidatesTokens: 75, totalTokens: 825 },
    total: { calls: 5, promptTokens: 1950, candidatesTokens: 195, totalTokens: 2145 },
  };

  it('shows token counts and "not configured" when no pricing is given', () => {
    const report = formatUsageReport(usage, null);
    assert.ok(report.includes('Цей прогін: 1 запит(ів), 55 токенів (ціна не налаштована)'));
    assert.ok(report.includes('Загалом: 5 запит(ів), 2145 токенів (ціна не налаштована)'));
  });

  it('computes a $ estimate when both input and output prices are given', () => {
    const report = formatUsageReport(usage, { input: 1, output: 2 }); // $1/$2 per 1M tokens
    // thisRun: 50 prompt tokens * $1/1M + 5 candidate tokens * $2/1M = 0.00005 + 0.00001 = 0.00006
    assert.ok(report.includes('~$0.0001') || report.includes('~$0.0000'), report);
  });

  it('shows "not configured" if only one of the two prices is given', () => {
    const report = formatUsageReport(usage, { input: 1, output: null });
    assert.ok(report.includes('ціна не налаштована'));
  });
});
