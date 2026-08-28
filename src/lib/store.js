import { rename, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultEventsPath = path.join(repoRoot, 'data', 'events.jsonl');

/** Reads all stored Opportunity records from a JSONL file. Returns [] if the file doesn't exist yet. */
export async function loadEvents(filePath = defaultEventsPath) {
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

/**
 * Returns the subset of `opportunities` not already present in the store
 * (by id), without writing anything. Lets a caller do work on just the
 * genuinely-new subset -- e.g. Vertex AI summarization -- BEFORE calling
 * appendNewEvents(), so the result (like `.summary`) gets persisted in
 * the same write instead of being computed and then silently discarded
 * (which is what happened before: summarization ran strictly after
 * storage, so no summary ever made it into data/events.jsonl).
 */
export async function filterNewOpportunities(opportunities, filePath = defaultEventsPath) {
  const existing = await loadEvents(filePath);
  const seenIds = new Set(existing.map((event) => event.id));
  return opportunities.filter((opportunity) => !seenIds.has(opportunity.id));
}

/**
 * Appends only the Opportunities whose `id` isn't already in the store.
 * Rewrites the whole file atomically (temp file + rename) so a crash
 * mid-write never leaves a truncated/corrupt events.jsonl behind.
 * Returns the subset of `opportunities` that were actually new.
 *
 * Most source modules never set `firstSeenAt` (only src/sources/notion.js
 * does, from Notion's own "Date found" created_time) -- this is the one
 * place every source's items pass through exactly once, on the run they
 * first get persisted, so it's the natural place to stamp "the date we
 * found this" for everyone else instead of leaving it null forever.
 */
export async function appendNewEvents(opportunities, filePath = defaultEventsPath) {
  const existing = await loadEvents(filePath);
  const seenIds = new Set(existing.map((event) => event.id));

  const newEvents = [];
  for (const opportunity of opportunities) {
    if (seenIds.has(opportunity.id)) continue;
    seenIds.add(opportunity.id);
    newEvents.push(opportunity.firstSeenAt ? opportunity : { ...opportunity, firstSeenAt: new Date().toISOString() });
  }

  if (newEvents.length === 0) return [];

  const allEvents = [...existing, ...newEvents];
  const contents = allEvents.map((event) => JSON.stringify(event)).join('\n') + '\n';

  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, contents, 'utf8');
  await rename(tempPath, filePath);

  return newEvents;
}
