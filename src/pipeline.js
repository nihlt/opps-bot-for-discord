import { setTimeout as delay } from 'node:timers/promises';
import { loadEnabledSources, fetchFromSource } from './sources/index.js';
import { appendNewEvents, loadEvents } from './lib/store.js';
import { applyEventPaymentPolicy } from './lib/normalize.js';
import { writeToFeed } from './lib/notion-feed.js';
import { postOpportunity } from './discord/post.js';

const FIRST_RUN_POST_CAP = 15;
const POST_DELAY_MS = 300;

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

  if (sources.length > 0 && failures.length === sources.length) {
    throw new Error(`All ${sources.length} enabled sources failed`);
  }

  return { opportunities, failures };
}

function pickFirstRunBatch(newEvents, cap) {
  if (newEvents.length <= cap) return newEvents;
  return [...newEvents]
    .sort((a, b) => (b.dateNormalized || '').localeCompare(a.dateNormalized || ''))
    .slice(0, cap);
}

/**
 * Scrapes every enabled source, dedupes against data/events.jsonl, and
 * posts genuinely new opportunities to Discord. On the very first run
 * (empty store) the post batch is capped to the newest N items so the
 * whole historical catalogue doesn't get dumped into the channel at
 * once — everything scraped is still recorded in the store regardless,
 * so nothing gets reposted as "new" on the next run.
 */
export async function runPipeline(client, { concurrency = Number(process.env.SCRAPE_CONCURRENCY) || 3 } = {}) {
  const wasFirstRun = (await loadEvents()).length === 0;

  const { opportunities, failures } = await scrapeAllSources(concurrency);
  const newEvents = await appendNewEvents(opportunities);

  let feedResult = { written: 0, skipped: 0, failures: [] };
  try {
    feedResult = await writeToFeed(newEvents);
  } catch (error) {
    console.error('[pipeline] notion-feed write failed:', error.message);
  }

  const toPost = wasFirstRun ? pickFirstRunBatch(newEvents, FIRST_RUN_POST_CAP) : newEvents;

  let postedCount = 0;
  for (const opportunity of toPost) {
    try {
      await postOpportunity(client, opportunity);
      postedCount += 1;
    } catch (error) {
      console.error(`[pipeline] failed to post "${opportunity.title}":`, error.message);
    }
    await delay(POST_DELAY_MS);
  }

  console.log(
    `[pipeline] scraped=${opportunities.length} new=${newEvents.length} posted=${postedCount}` +
      ` notionFeedWritten=${feedResult.written}` +
      (wasFirstRun ? ' (first run, capped)' : '') +
      (failures.length ? ` failedSources=${failures.map((f) => f.sourceId).join(',')}` : '') +
      (feedResult.failures.length ? ` notionFeedFailures=${feedResult.failures.length}` : ''),
  );

  return {
    scraped: opportunities.length,
    newCount: newEvents.length,
    postedCount,
    failures,
    wasFirstRun,
    notionFeed: feedResult,
  };
}
