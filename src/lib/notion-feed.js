import { Client } from '@notionhq/client';

const MAX_TEXT_LENGTH = 1900;

function truncate(text) {
  if (!text) return null;
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

function richText(text) {
  const value = truncate(text);
  return value ? [{ text: { content: value } }] : [];
}

function buildDeadlineProperty(opportunity) {
  if (!opportunity.dateNormalized) return null;
  return {
    date: {
      start: opportunity.dateNormalized,
      end: opportunity.dateEndNormalized || undefined,
    },
  };
}

/**
 * Maps our Opportunity shape onto the "Opportunities Feed" database's
 * properties. Score is intentionally never set here -- a separately
 * scheduled agent fills it in after the fact.
 */
export function toFeedProperties(opportunity) {
  const properties = {
    Name: { title: richText(opportunity.title || 'Untitled') },
    Kind: { select: { name: opportunity.kind } },
    Source: { select: { name: opportunity.sourceId } },
    'External Id': { rich_text: richText(opportunity.id) },
  };

  if (opportunity.link) properties.Link = { url: opportunity.link };
  if (opportunity.tags?.length) properties.Tags = { multi_select: opportunity.tags.map((tag) => ({ name: tag })) };
  if (opportunity.location) properties.Location = { rich_text: richText(opportunity.location) };
  if (opportunity.payment) properties.Payment = { rich_text: richText(opportunity.payment) };
  if (opportunity.description) properties.Description = { rich_text: richText(opportunity.description) };
  if (opportunity.company) properties.Company = { rich_text: richText(opportunity.company) };

  const deadline = buildDeadlineProperty(opportunity);
  if (deadline) properties.Deadline = deadline;

  return properties;
}

/**
 * Writes scraped opportunities into the "Opportunities Feed" database, for
 * a separately-scheduled agent to score later (Score is left blank).
 * Notion-sourced opportunities are skipped -- they already live in Notion,
 * writing them back would be circular. Per-item failures are collected
 * rather than thrown, so one bad page doesn't drop the rest of the batch.
 */
export async function writeToFeed(opportunities, { feedDatabaseId = process.env.NOTION_FEED_DATABASE_ID } = {}) {
  if (!feedDatabaseId) throw new Error('NOTION_FEED_DATABASE_ID is not set');

  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const toWrite = opportunities.filter((opportunity) => opportunity.sourceId !== 'notion');

  let written = 0;
  const failures = [];

  for (const opportunity of toWrite) {
    try {
      await notion.pages.create({
        parent: { database_id: feedDatabaseId },
        properties: toFeedProperties(opportunity),
      });
      written += 1;
    } catch (error) {
      failures.push({ id: opportunity.id, message: error.message });
      console.error(`[notion-feed] failed to write "${opportunity.title}":`, error.message);
    }
  }

  return { written, skipped: opportunities.length - toWrite.length, failures };
}
