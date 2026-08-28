import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultUsagePath = path.join(repoRoot, 'data', 'llm-usage.jsonl');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Appends one Vertex AI call's token usage to the log (one line per call,
 * plain append -- order doesn't matter for aggregation, so this doesn't
 * need lib/store.js's atomic-rewrite dance). Never throws on a write
 * failure being the caller's problem to decide how to handle; this
 * module just persists what it's given.
 */
export async function recordUsage(
  { model, promptTokens, candidatesTokens, totalTokens, timestamp = new Date().toISOString() },
  filePath = defaultUsagePath,
) {
  const line = JSON.stringify({ timestamp, model, promptTokens, candidatesTokens, totalTokens }) + '\n';
  await appendFile(filePath, line, 'utf8');
}

/** Reads all recorded usage lines. Returns [] if the log doesn't exist yet. */
export async function loadUsage(filePath = defaultUsagePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sumTokens(records) {
  return records.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + (r.promptTokens || 0),
      candidatesTokens: acc.candidatesTokens + (r.candidatesTokens || 0),
      totalTokens: acc.totalTokens + (r.totalTokens || 0),
    }),
    { calls: 0, promptTokens: 0, candidatesTokens: 0, totalTokens: 0 },
  );
}

function withinLastDays(records, days, now) {
  const cutoff = now - days * DAY_MS;
  return records.filter((r) => Date.parse(r.timestamp) >= cutoff);
}

/**
 * Aggregates usage records into four buckets: this run (everything at or
 * after `runStartedAt`, an ISO timestamp), the last 7 days, the last 30
 * days, and all-time. `now` is injectable for tests; defaults to the
 * real current time.
 */
export function summarizeUsage(records, runStartedAt, now = Date.now()) {
  const runStartMs = Date.parse(runStartedAt);
  return {
    thisRun: sumTokens(records.filter((r) => Date.parse(r.timestamp) >= runStartMs)),
    week: sumTokens(withinLastDays(records, 7, now)),
    month: sumTokens(withinLastDays(records, 30, now)),
    total: sumTokens(records),
  };
}

/**
 * Cost per bucket, only if BOTH per-million-token prices are given --
 * otherwise null, rather than guessing a number. There's no reliable
 * built-in knowledge of what a given Gemini model costs per token (rates
 * vary by model and can change), so this deliberately requires the
 * caller to supply real, current pricing (see GEMINI_INPUT_PRICE_PER_1M_TOKENS
 * / GEMINI_OUTPUT_PRICE_PER_1M_TOKENS in .env.example) rather than
 * fabricating one.
 */
function estimateCost(usage, pricePerMillion) {
  if (!pricePerMillion || pricePerMillion.input == null || pricePerMillion.output == null) return null;
  return (usage.promptTokens / 1_000_000) * pricePerMillion.input + (usage.candidatesTokens / 1_000_000) * pricePerMillion.output;
}

/** Renders the four-bucket usage summary as plain text lines, for an admin DM. */
export function formatUsageReport(usage, pricePerMillion) {
  const line = (label, bucket) => {
    const cost = estimateCost(bucket, pricePerMillion);
    const costText = cost === null ? 'ціна не налаштована' : `~$${cost.toFixed(4)}`;
    return `${label}: ${bucket.calls} запит(ів), ${bucket.totalTokens} токенів (${costText})`;
  };
  return [
    line('Цей прогін', usage.thisRun),
    line('За 7 днів', usage.week),
    line('За 30 днів', usage.month),
    line('Загалом', usage.total),
  ].join('\n');
}
