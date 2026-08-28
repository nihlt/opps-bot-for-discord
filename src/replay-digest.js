import 'dotenv/config';
import { createDiscordClient } from './discord/client.js';
import { postDigest } from './discord/digest.js';
import { notifyAdmins } from './discord/alerts.js';
import { resolveChannelTarget } from './discord/target.js';
import { loadEvents } from './lib/store.js';
import { loadUsage, summarizeUsage, formatUsageReport } from './lib/llm-usage.js';
import {
  parseDayKeyArg,
  dayKeyRange,
  groupOpportunitiesByDay,
  dayKeyToDisplayDate,
  dayKeyToShort,
  utcDateKey,
} from './lib/replay.js';

/**
 * Manual preview tool, not part of the scheduled pipeline: replays the
 * ALREADY-STORED catalogue (data/events.jsonl) as a sequence of one
 * digest per calendar day, from a given start date through today --
 * exactly what each of those days' real runs would have posted, using
 * postDigest() unmodified. Read-only against everything except Discord
 * itself: no scraping, no LLM calls, no writes to events.jsonl or the
 * Notion Feed. Usage: `node src/replay-digest.js 20.08` (through today), or
 * `node src/replay-digest.js 08.08 08.08` (a single specific day).
 */
async function main() {
  const startArg = process.argv[2];
  const endArg = process.argv[3];
  if (!startArg) throw new Error('Usage: node src/replay-digest.js <DD.MM|YYYY-MM-DD> [endDD.MM|YYYY-MM-DD]');

  const { channelId, target } = resolveChannelTarget();

  const runStartedAt = new Date().toISOString();
  const startKey = parseDayKeyArg(startArg);
  const endKey = endArg ? parseDayKeyArg(endArg) : utcDateKey(new Date());
  const days = dayKeyRange(startKey, endKey);

  const client = await createDiscordClient();
  console.log(
    `[replay] logged in as ${client.user.tag}, target=${target}, replaying ${startKey}..${endKey} (${days.length} day(s))`,
  );

  const catalogue = await loadEvents();
  const byDay = groupOpportunitiesByDay(catalogue);
  const channel = await client.channels.fetch(channelId);

  const issues = [];
  for (const dayKey of days) {
    const items = (byDay.get(dayKey) || []).filter((o) => o.relevant !== false);
    if (items.length === 0) {
      console.log(`[replay] ${dayKey}: 0 item(s), skipped`);
      continue;
    }
    try {
      // scoringPopulation is the whole current catalogue, same as a real
      // run (pipeline.js always scores against everything ever seen, not
      // just what existed up to that day) -- so percentile colors match
      // what postDigest() would produce for real, not a synthetic replay.
      await postDigest(channel, items, { scoringPopulation: catalogue, date: dayKeyToDisplayDate(dayKey) });
      console.log(`[replay] ${dayKey}: posted ${items.length} item(s)`);
    } catch (error) {
      issues.push(`${dayKey}: ${error.message}`);
      console.error(`[replay] ${dayKey}: failed to post:`, error.message);
    }
  }

  // One admin DM at the end, not one per simulated day -- this replay makes
  // no new LLM calls, so the usage report just reflects real historical
  // totals (see llm-usage.js), same shape as the normal per-run DM.
  const usageRecords = await loadUsage();
  const usageSummary = summarizeUsage(usageRecords, runStartedAt);
  const replayLabel =
    startKey === endKey ? `Replay ${dayKeyToShort(startKey)}` : `Replay ${dayKeyToShort(startKey)}–${dayKeyToShort(endKey)}`;
  const context = target === 'test' ? `TEST · ${replayLabel}` : replayLabel;

  const reportLines = [];
  if (issues.length > 0) {
    reportLines.push(`${issues.length} issue(s) during replay:`, ...issues.map((issue, i) => `${i + 1}. ${issue}`), '');
  }
  reportLines.push(formatUsageReport(usageSummary, { model: process.env.GEMINI_MODEL, context }));
  await notifyAdmins(client, reportLines.join('\n'));

  await client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[replay] fatal error:', error);
    process.exit(1);
  });
