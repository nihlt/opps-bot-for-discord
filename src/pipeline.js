import { loadEnabledSources, fetchFromSource } from './sources/index.js';
import { appendNewEvents, loadEvents, filterNewOpportunities } from './lib/store.js';
import { applyEventPaymentPolicy } from './lib/normalize.js';
import { attachSummaries } from './lib/summarize.js';
import { writeToFeed } from './lib/notion-feed.js';
import { postDigest } from './discord/digest.js';
import { notifyAdmins } from './discord/alerts.js';
import { recordUsage, loadUsage, summarizeUsage, formatUsageReport } from './lib/llm-usage.js';

const FIRST_RUN_POST_CAP = 15;

/**
 * On the very first run ever (empty store), a fresh scrape can return the
 * source sites' entire current listings as "new". Capping to the newest N
 * keeps day one from dumping the whole historical catalogue into the
 * digest thread at once -- everything scraped is still recorded in the
 * store regardless, so nothing gets reposted as "new" on the next run.
 */
function pickFirstRunBatch(newEvents, cap) {
  if (newEvents.length <= cap) return newEvents;
  return [...newEvents]
    .sort((a, b) => (b.dateNormalized || '').localeCompare(a.dateNormalized || ''))
    .slice(0, cap);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

async function scrapeAllSources(concurrency) {
  const sources = await loadEnabledSources();
  const opportunities = [];
  const failures = [];

  await mapWithConcurrency(sources, concurrency, async (sourceConfig) => {
    try {
      const fetched = await fetchFromSource(sourceConfig);
      for (const opportunity of fetched) {
        const kept = applyEventPaymentPolicy(opportunity);
        if (kept) opportunities.push(kept);
      }
    } catch (error) {
      failures.push({ sourceId: sourceConfig.id, message: error.message });
      console.error(`[pipeline] source "${sourceConfig.id}" failed:`, error.message);
    }
  });

  return { opportunities, failures, totalSources: sources.length };
}

/**
 * Items whose firstSeenAt falls within the last `lookbackDays`, out of
 * the full stored catalogue -- not just this run's newly-appended items.
 * Used for an explicit, on-demand "show me the last N days" digest
 * (DIGEST_LOOKBACK_DAYS), separate from the normal daily behavior (which
 * posts only what's genuinely new since the last run, and never risks
 * re-posting the same item twice). An item with no firstSeenAt (shouldn't
 * happen going forward -- see lib/store.js -- but could for anything
 * persisted before that fix shipped) is excluded rather than guessed at.
 */
function withinLookbackWindow(catalogue, lookbackDays) {
  const windowStart = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  return catalogue.filter((opportunity) => opportunity.firstSeenAt && Date.parse(opportunity.firstSeenAt) >= windowStart);
}

/**
 * Scrapes every enabled source, dedupes against data/events.jsonl,
 * summarizes new items via Vertex AI, writes them to the Notion Feed, and
 * posts a digest to Discord (top 3 in the channel message, the rest in a
 * thread). Every distinct problem encountered along the way is collected
 * into `issues` and DMed to every ADMIN_DISCORD_USER_IDS admin ONCE at the
 * end of the run (see discord/alerts.js) -- house policy is "alert on
 * every failure, no exceptions," but batched into one message per run
 * rather than one DM per problem.
 */
export async function runPipeline(
  client,
  {
    concurrency = Number(process.env.SCRAPE_CONCURRENCY) || 3,
    // Ad-hoc/manual use only -- e.g. `DIGEST_LOOKBACK_DAYS=3 npm start` to
    // see everything found in the last 3 days. Left unset, the normal
    // daily behavior (post only this run's genuinely-new items) applies;
    // setting it switches to re-scanning the whole catalogue by
    // firstSeenAt, which WILL re-post an item already posted in an
    // earlier run today if run more than once within the window -- an
    // accepted tradeoff for a deliberately-requested retrospective view,
    // not something the scheduled GitHub Actions run should ever set.
    lookbackDays = process.env.DIGEST_LOOKBACK_DAYS ? Number(process.env.DIGEST_LOOKBACK_DAYS) : null,
  } = {},
) {
  const issues = [];
  const runStartedAt = new Date().toISOString();
  const wasFirstRun = (await loadEvents()).length === 0;

  const { opportunities, failures, totalSources } = await scrapeAllSources(concurrency);
  if (failures.length > 0) {
    const label = failures.length === totalSources ? 'ALL sources failed' : 'Some sources failed';
    issues.push(`${label}: ${failures.map((f) => `${f.sourceId} (${f.message})`).join('; ')}`);
  }

  // Summarize BEFORE persisting, not after -- so `.summary` ends up in
  // the same store write as everything else instead of being computed
  // and then discarded (see lib/store.js's filterNewOpportunities()).
  const candidates = await filterNewOpportunities(opportunities);
  const summarized = await attachSummaries(
    candidates,
    {
      onUsage: (usage) =>
        recordUsage(usage).catch((error) => console.error('[pipeline] failed to record LLM usage:', error.message)),
    },
    (error) => {
      issues.push(`Vertex AI summarization failed, posted/written without summaries: ${error.message}`);
    },
  );
  const newEvents = await appendNewEvents(summarized);
  const catalogue = await loadEvents(); // full stored catalogue, including today's new events -- used to rank/highlight against, not just today's batch

  // Everything above persists to the store regardless of the LLM's verdict
  // (see attachSummaries in lib/summarize.js) -- a vetoed item is never
  // re-scraped/re-sent to the LLM tomorrow. The veto only applies here, at
  // the display/write boundary: `relevant: false` means Notion Feed and the
  // Discord digest never see it, at all, regardless of its heuristic score.
  const relevantNewEvents = newEvents.filter((o) => o.relevant !== false);

  let feedResult = { written: 0, skipped: 0, failures: [] };
  try {
    feedResult = await writeToFeed(relevantNewEvents);
    if (feedResult.failures.length > 0) {
      issues.push(`Notion Feed: ${feedResult.failures.length} row(s) failed to write: ${feedResult.failures.map((f) => f.message).join('; ')}`);
    }
  } catch (error) {
    issues.push(`Notion Feed write failed entirely: ${error.message}`);
    console.error('[pipeline] notion-feed write failed:', error.message);
  }

  const toPost = lookbackDays
    ? withinLookbackWindow(catalogue, lookbackDays).filter((o) => o.relevant !== false)
    : wasFirstRun
      ? pickFirstRunBatch(relevantNewEvents, FIRST_RUN_POST_CAP)
      : relevantNewEvents;

  let digestMessage = null;
  if (toPost.length > 0) {
    try {
      const channelId = process.env.DISCORD_CHANNEL_ID;
      if (!channelId) throw new Error('DISCORD_CHANNEL_ID is not set');
      const channel = await client.channels.fetch(channelId);
      digestMessage = await postDigest(channel, toPost, { scoringPopulation: catalogue });
    } catch (error) {
      issues.push(`Discord digest post failed: ${error.message}`);
      console.error('[pipeline] failed to post digest:', error.message);
    }
  }

  console.log(
    `[pipeline] scraped=${opportunities.length} new=${newEvents.length} posted=${digestMessage ? 'yes' : 'no'}` +
      ` notionFeedWritten=${feedResult.written}` +
      (wasFirstRun ? ' (first run, capped)' : '') +
      (lookbackDays ? ` (lookback=${lookbackDays}d, toPost=${toPost.length})` : '') +
      (issues.length ? ` issues=${issues.length}` : ''),
  );

  // Sent EVERY run now, not just when issues exist -- per explicit
  // request to see LLM spend (this run / 7d / 30d / all-time) every
  // time, not only when something breaks. Issues, if any, still lead the
  // message so they're not buried under the routine cost line.
  const usageRecords = await loadUsage();
  const usageSummary = summarizeUsage(usageRecords, runStartedAt);

  const reportLines = [];
  if (issues.length > 0) {
    reportLines.push(`${issues.length} issue(s) this run:`, ...issues.map((issue, i) => `${i + 1}. ${issue}`), '');
  }
  reportLines.push(formatUsageReport(usageSummary, { model: process.env.GEMINI_MODEL }));

  await notifyAdmins(client, reportLines.join('\n'));

  return {
    scraped: opportunities.length,
    newCount: newEvents.length,
    posted: digestMessage !== null,
    wasFirstRun,
    notionFeed: feedResult,
    usage: usageSummary,
    issues,
  };
}
