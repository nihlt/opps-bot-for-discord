import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultUsagePath = path.join(repoRoot, 'data', 'llm-usage.jsonl');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Vertex AI pricing for GEMINI_MODEL (gemini-3.7-flash), $ per 1M tokens,
 * as given directly by the user from Google's official pricing. Listed
 * with effective-from dates specifically because the price is scheduled
 * to change on 2027-01-01 -- a flat constant would silently start
 * under-reporting cost by 2x the moment that date passes. Each usage
 * record is priced using whichever tier was in effect on ITS OWN
 * timestamp (see priceFor()), not "whatever tier applies today," so
 * historical totals stay correct even once a newer tier exists.
 *
 * "Output" here means output+thinking tokens combined -- Vertex AI bills
 * them at the same rate, and candidatesTokenCount is what Gemini's
 * usageMetadata reports for that combined figure (see summarize.js).
 *
 * Only covers the pricing this codebase actually incurs (plain
 * generateContent calls) -- context caching and Search/Maps grounding
 * are priced separately but aren't used anywhere in this pipeline, so
 * they're deliberately not modeled here. If GEMINI_MODEL ever changes to
 * a different model, this table needs updating by hand -- there's no API
 * this code calls to fetch live pricing.
 */
const PRICING_SCHEDULE = [
  { from: '2020-01-01T00:00:00.000Z', inputPerMillion: 0.75, outputPerMillion: 3.75 },
  { from: '2027-01-01T00:00:00.000Z', inputPerMillion: 1.5, outputPerMillion: 7.5 },
];

function priceFor(timestamp) {
  const t = Date.parse(timestamp);
  let applicable = PRICING_SCHEDULE[0];
  for (const tier of PRICING_SCHEDULE) {
    if (Date.parse(tier.from) <= t) applicable = tier;
  }
  return applicable;
}

function costOf(record) {
  const price = priceFor(record.timestamp);
  return (
    ((record.promptTokens || 0) / 1_000_000) * price.inputPerMillion +
    ((record.candidatesTokens || 0) / 1_000_000) * price.outputPerMillion
  );
}

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

function summarizeBucket(records) {
  return records.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + (r.promptTokens || 0),
      candidatesTokens: acc.candidatesTokens + (r.candidatesTokens || 0),
      totalTokens: acc.totalTokens + (r.totalTokens || 0),
      cost: acc.cost + costOf(r),
    }),
    { calls: 0, promptTokens: 0, candidatesTokens: 0, totalTokens: 0, cost: 0 },
  );
}

function withinLastDays(records, days, now) {
  const cutoff = now - days * DAY_MS;
  return records.filter((r) => Date.parse(r.timestamp) >= cutoff);
}

/**
 * Aggregates usage records into four buckets: this run (everything at or
 * after `runStartedAt`, an ISO timestamp), the last 7 days, the last 30
 * days, and all-time -- each with a `cost` field priced per-record via
 * PRICING_SCHEDULE. `now` is injectable for tests; defaults to the real
 * current time.
 */
export function summarizeUsage(records, runStartedAt, now = Date.now()) {
  const runStartMs = Date.parse(runStartedAt);
  return {
    thisRun: summarizeBucket(records.filter((r) => Date.parse(r.timestamp) >= runStartMs)),
    week: summarizeBucket(withinLastDays(records, 7, now)),
    month: summarizeBucket(withinLastDays(records, 30, now)),
    total: summarizeBucket(records),
  };
}

// "gemini-3.7-flash" -> "Gemini 3.7 Flash" -- each hyphen-separated part
// that starts with a letter gets capitalized; a version number like "3.7"
// is left as-is. Falls back to the raw id for a shape this doesn't expect
// rather than mangling it.
function prettyModelName(id) {
  if (!id) return null;
  return id
    .split('-')
    .map((part) => (/^[a-zA-Z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

const USAGE_TABLE_ROWS = [
  { key: 'thisRun', label: 'Run' },
  { key: 'week', label: '7d' },
  { key: 'month', label: '30d' },
  { key: 'total', label: 'All' },
];

// A monospace table, column widths sized to the actual content (not fixed)
// so a wide total token count or cost never throws off alignment the way a
// fixed-width format would.
function renderUsageTable(usage) {
  const rows = USAGE_TABLE_ROWS.map(({ key, label }) => {
    const bucket = usage[key];
    return { label, requests: String(bucket.calls), tokens: String(bucket.totalTokens), cost: `$${bucket.cost.toFixed(4)}` };
  });

  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const requestsWidth = Math.max('Requests'.length, ...rows.map((r) => r.requests.length));
  const tokensWidth = Math.max('Tokens'.length, ...rows.map((r) => r.tokens.length));
  const costWidth = Math.max('Cost'.length, ...rows.map((r) => r.cost.length));

  const headerRow = [' '.repeat(labelWidth), 'Requests'.padStart(requestsWidth), 'Tokens'.padStart(tokensWidth), 'Cost'.padStart(costWidth)].join('  ');
  const dataRows = rows.map((r) =>
    [r.label.padEnd(labelWidth), r.requests.padStart(requestsWidth), r.tokens.padStart(tokensWidth), r.cost.padStart(costWidth)].join('  '),
  );
  return [headerRow, ...dataRows].join('\n');
}

/**
 * Renders the four-bucket usage summary as a title line ("LLM Usage ·
 * {model} · {context}", either optional) followed by an aligned monospace
 * table in a code block, for an admin DM. `model` is the raw GEMINI_MODEL
 * id (e.g. "gemini-3.7-flash") -- prettified here so callers don't each
 * reimplement that. `context` is a short caller-supplied tag, e.g. a
 * replay's date range -- omitted for a normal run.
 */
export function formatUsageReport(usage, { model, context } = {}) {
  const title = ['LLM Usage', prettyModelName(model), context].filter(Boolean).join(' · ');
  return `${title}\n\n\`\`\`text\n${renderUsageTable(usage)}\n\`\`\``;
}
