import { loadEnabledSources, fetchFromSource } from './sources/index.js';
import { appendNewEvents, loadEvents } from './lib/store.js';
import { applyEventPaymentPolicy } from './lib/normalize.js';
import { attachSummaries } from './lib/summarize.js';
import { writeToFeed } from './lib/notion-feed.js';
import { postDigest } from './discord/digest.js';
import { notifyAdmins } from './discord/alerts.js';

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
 * Scrapes every enabled source, dedupes against data/events.jsonl,
 * summarizes new items via Vertex AI, writes them to the Notion Feed, and
 * posts a digest to Discord (top 3 in the channel message, the rest in a
 * thread). Every distinct problem encountered along the way is collected
 * into `issues` and DMed to every ADMIN_DISCORD_USER_IDS admin ONCE at the
 * end of the run (see discord/alerts.js) -- house policy is "alert on
 * every failure, no exceptions," but batched into one message per run
 * rather than one DM per problem.
 */
export async function runPipeline(client, { concurrency = Number(process.env.SCRAPE_CONCURRENCY) || 3 } = {}) {
  const issues = [];
  const wasFirstRun = (await loadEvents()).length === 0;

  const { opportunities, failures, totalSources } = await scrapeAllSources(concurrency);
  if (failures.length > 0) {
    const label = failures.length === totalSources ? 'ALL sources failed' : 'Some sources failed';
    issues.push(`${label}: ${failures.map((f) => `${f.sourceId} (${f.message})`).join('; ')}`);
  }

  const newEvents = await appendNewEvents(opportunities);
  const catalogue = await loadEvents(); // full stored catalogue, including today's new events -- used to rank/highlight against, not just today's batch
  const summarized = await attachSummaries(newEvents, undefined, (error) => {
    issues.push(`Vertex AI summarization failed, posted/written without summaries: ${error.message}`);
  });

  let feedResult = { written: 0, skipped: 0, failures: [] };
  try {
    feedResult = await writeToFeed(summarized);
    if (feedResult.failures.length > 0) {
      issues.push(`Notion Feed: ${feedResult.failures.length} row(s) failed to write: ${feedResult.failures.map((f) => f.message).join('; ')}`);
    }
  } catch (error) {
    issues.push(`Notion Feed write failed entirely: ${error.message}`);
    console.error('[pipeline] notion-feed write failed:', error.message);
  }

  const toPost = wasFirstRun ? pickFirstRunBatch(summarized, FIRST_RUN_POST_CAP) : summarized;

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
      (issues.length ? ` issues=${issues.length}` : ''),
  );

  if (issues.length > 0) {
    await notifyAdmins(
      client,
      `[opps-bot] ${issues.length} issue(s) this run:\n${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}`,
    );
  }

  return {
    scraped: opportunities.length,
    newCount: newEvents.length,
    posted: digestMessage !== null,
    wasFirstRun,
    notionFeed: feedResult,
    issues,
  };
}
