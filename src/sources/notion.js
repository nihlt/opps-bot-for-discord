import { Client } from '@notionhq/client';
import { loadKeywordRules, normalizeOpportunity, tagsFromKeywords, uniqueStrings } from '../lib/normalize.js';

function plainText(richTextArray) {
  return (richTextArray || []).map((part) => part.plain_text).join('');
}

function mapRow(page) {
  const props = page.properties;
  return {
    title: plainText(props.Name?.title),
    link: props.Link?.url || null,
    type: props.Type?.select?.name || null,
    location: plainText(props.Location?.rich_text) || null,
    funded: Boolean(props.Funded?.checkbox),
    deadline: props.Deadline?.date || null,
    firstSeenAt: props['Date found']?.created_time || null,
    status: props.Status?.select?.name || null,
  };
}

/**
 * Notion's Deadline property is already a structured ISO date, so it maps
 * directly onto dateNormalized/dateEndNormalized instead of going through
 * normalizeOpportunity's free-text parseDate().
 */
function withDeadline(opportunity, deadline) {
  return {
    ...opportunity,
    date: deadline?.start || null,
    dateNormalized: deadline?.start || null,
    dateEndNormalized: deadline?.end || null,
    datePrecision: deadline ? 'date' : 'unknown',
  };
}

/** @type {import('./index.js').SourceModule['fetchOpportunities']} */
export async function fetchOpportunities(sourceConfig) {
  await loadKeywordRules();
  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const opportunities = [];
  let cursor;

  do {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      const row = mapRow(page);
      if (row.status === 'Skip') continue;
      if (!row.title || !row.link) continue;

      const opportunity = normalizeOpportunity({
        sourceId: sourceConfig.id,
        kind: 'event',
        title: row.title,
        link: row.link,
        location: row.location,
        payment: row.funded ? 'funded' : null,
        tags: uniqueStrings([row.type, ...tagsFromKeywords(row.title)]),
        firstSeenAt: row.firstSeenAt,
      });

      opportunities.push(withDeadline(opportunity, row.deadline));
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return opportunities;
}
