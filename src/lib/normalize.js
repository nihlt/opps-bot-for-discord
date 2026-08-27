import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tagKeywordsPath = path.join(repoRoot, 'data', 'tag-keywords.json');
const locationKeywordsPath = path.join(repoRoot, 'data', 'location-keywords.json');

let tagKeywordRules = [];
let locationKeywordRules = [];

export function cleanText(value) {
  return String(value ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function uniqueStrings(values) {
  return [...new Set((values || []).map(cleanText).filter(Boolean))];
}

/**
 * Stable id for an Opportunity: sha256 of `${sourceId}:${link}`.
 * Same (sourceId, link) always produces the same id, so re-scraping
 * the same item across runs dedupes instead of reposting.
 */
export function makeId(sourceId, link) {
  return createHash('sha256').update(`${sourceId}:${link}`, 'utf8').digest('hex');
}

function keywordRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[a-z0-9 .+-]+$/i.test(keyword)) {
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  }
  return new RegExp(escaped, 'i');
}

function tokenRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
}

function compileRulePatterns(rule) {
  const tokenPatterns = (rule.tokens || []).map(tokenRegex);
  const rawPatterns = (rule.patterns || []).map((pattern) => new RegExp(pattern, 'iu'));
  const combined = [...tokenPatterns, ...rawPatterns];
  if (combined.length) return combined;
  return (rule.keywords || []).map(keywordRegex);
}

/** Loads data/tag-keywords.json and data/location-keywords.json. Call once at startup. */
export async function loadKeywordRules() {
  tagKeywordRules = JSON.parse(await readFile(tagKeywordsPath, 'utf8')).map((rule) => ({
    ...rule,
    patterns: compileRulePatterns(rule),
  }));
  locationKeywordRules = JSON.parse(await readFile(locationKeywordsPath, 'utf8'));
}

export function tagsFromKeywords(text) {
  return tagKeywordRules
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(text)))
    .map((rule) => rule.tag);
}

export function locationFromKeywords(text) {
  const matches = locationKeywordRules
    .filter((rule) => rule.keywords.some((keyword) => keywordRegex(keyword).test(text)))
    .map((rule) => rule.location);
  return matches.length ? matches.join(', ') : null;
}

const ukrainianMonths = new Map([
  ['січня', 1], ['лютого', 2], ['березня', 3], ['квітня', 4],
  ['травня', 5], ['червня', 6], ['липня', 7], ['серпня', 8],
  ['вересня', 9], ['жовтня', 10], ['листопада', 11], ['грудня', 12],
]);

const englishMonths = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3], ['apr', 4], ['april', 4],
  ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10], ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateOnly(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseMeridiemTime(hourText, minuteText, secondText, meridiem) {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || 0);
  if (/pm/i.test(meridiem) && hour !== 12) hour += 12;
  if (/am/i.test(meridiem) && hour === 12) hour = 0;
  return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

/**
 * Parses a free-text date string (Ukrainian/English, single date, date
 * range, or Kaggle-style datetime) into { dateNormalized, dateEndNormalized,
 * datePrecision }. Returns datePrecision: 'unknown' when nothing matches.
 */
export function parseDate(rawDate, { scrapedAt } = {}) {
  const date = cleanText(rawDate);
  if (!date) {
    return { dateNormalized: null, dateEndNormalized: null, datePrecision: 'unknown' };
  }

  const scrapedYear = scrapedAt ? new Date(scrapedAt).getUTCFullYear() : new Date().getUTCFullYear();

  const kaggleMatch = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (kaggleMatch) {
    const [, month, day, year, hour, minute, second, meridiem] = kaggleMatch;
    return {
      dateNormalized: `${dateOnly(Number(year), Number(month), Number(day))}T${parseMeridiemTime(hour, minute, second, meridiem)}`,
      dateEndNormalized: null,
      datePrecision: 'datetime',
    };
  }

  const ukrainianRangeMatch = date.match(/^(\d{1,2})\s*[—-]\s*(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)(?:\s+(\d{4})\s+року)?$/i);
  if (ukrainianRangeMatch) {
    const [, startDay, endDay, monthText, yearText] = ukrainianRangeMatch;
    const year = Number(yearText || scrapedYear);
    const month = ukrainianMonths.get(monthText.toLowerCase());
    return {
      dateNormalized: dateOnly(year, month, Number(startDay)),
      dateEndNormalized: dateOnly(year, month, Number(endDay)),
      datePrecision: 'date_range',
    };
  }

  const ukrainianDateMatch = date.match(/^(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)(?:\s+(\d{4})\s+року)?$/i);
  if (ukrainianDateMatch) {
    const [, day, monthText, yearText] = ukrainianDateMatch;
    const year = Number(yearText || scrapedYear);
    const month = ukrainianMonths.get(monthText.toLowerCase());
    return {
      dateNormalized: dateOnly(year, month, Number(day)),
      dateEndNormalized: null,
      datePrecision: 'date',
    };
  }

  const englishShortDateMatch = date.match(/^(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})$/);
  if (englishShortDateMatch) {
    const [, day, monthText, year] = englishShortDateMatch;
    const month = englishMonths.get(monthText.toLowerCase());
    if (month) {
      return {
        dateNormalized: dateOnly(Number(year), month, Number(day)),
        dateEndNormalized: null,
        datePrecision: 'date',
      };
    }
  }

  const englishMonthRangeMatch = date.match(/^([A-Z][a-z]+)\s+(\d{1,2})\s*[—-]\s*(\d{1,2}),\s*(\d{4})$/);
  if (englishMonthRangeMatch) {
    const [, monthText, startDay, endDay, year] = englishMonthRangeMatch;
    const month = englishMonths.get(monthText.toLowerCase());
    if (month) {
      return {
        dateNormalized: dateOnly(Number(year), month, Number(startDay)),
        dateEndNormalized: dateOnly(Number(year), month, Number(endDay)),
        datePrecision: 'date_range',
      };
    }
  }

  const isoMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return {
      dateNormalized: dateOnly(Number(year), Number(month), Number(day)),
      dateEndNormalized: null,
      datePrecision: 'date',
    };
  }

  return { dateNormalized: null, dateEndNormalized: null, datePrecision: 'unknown' };
}

const freeIndicatorPattern = /безкоштов|безоплат|\bfree\b/i;
const currencyAmountPattern = /(?:[$€£¥₴]\s?\d[\d,.]*|\d[\d,.]*\s?(?:usd|eur|gbp|uah|грн))/i;
const fellowshipPattern = /fellowship|стипенді\p{L}*|стипенд\p{L}*|grant|грант\p{L}*/iu;

/**
 * True when the opportunity's own title/tags read as a fellowship/stipend
 * program. Deliberately excludes the description: a fellowship names
 * itself as such in the title, while long scraped descriptions often
 * mention "grant"/"грант" in passing (e.g. a conference discussing grant
 * funding as a topic) without the event itself being one.
 */
export function isFellowship(opportunity) {
  const text = [opportunity.title, ...(opportunity.tags || [])].filter(Boolean).join(' ');
  return fellowshipPattern.test(text);
}

function hasAttendanceCost(opportunity) {
  const payment = opportunity.payment || '';
  return currencyAmountPattern.test(payment) && !freeIndicatorPattern.test(payment);
}

/**
 * House convention: paid courses/events get dropped from the feed
 * entirely, and a payment amount is only ever shown for fellowships
 * (money paid TO the participant) — never a price to attend. Kaggle's
 * `payment` is prize money, not a cost, so it's exempt; job listings
 * keep their own salary semantics untouched (kind !== 'event').
 * Returns null to signal "drop this opportunity", otherwise the
 * opportunity (with `payment` cleared unless it's a fellowship).
 */
export function applyEventPaymentPolicy(opportunity) {
  if (opportunity.kind !== 'event' || opportunity.sourceId === 'kaggle') return opportunity;
  if (isFellowship(opportunity)) return opportunity;
  if (hasAttendanceCost(opportunity)) return null;
  if (opportunity.payment === null) return opportunity;
  return { ...opportunity, payment: null };
}

/**
 * The shared Opportunity shape every source module must produce (after
 * being passed through this function). `raw.sourceId` + `raw.link` decide
 * the stable `id` used for cross-run dedupe in lib/store.js.
 *
 * raw: {
 *   sourceId, title, link, date, location, payment, tags, description,
 *   company, calendar, kind, firstSeenAt
 * }
 */
export function normalizeOpportunity(raw, options = {}) {
  const inferDetails = options.inferDetails ?? true;
  const title = cleanText(raw.title);
  const link = raw.link || null;
  const searchableText = [title, cleanText(raw.description)].filter(Boolean).join('\n');
  const date = cleanText(raw.date);
  const { dateNormalized, dateEndNormalized, datePrecision } = parseDate(date, { scrapedAt: options.scrapedAt });
  const location = cleanText(raw.location) || (inferDetails ? locationFromKeywords(searchableText) : null);
  const tags = uniqueStrings([...(raw.tags || []), ...(inferDetails ? tagsFromKeywords(searchableText) : [])]);

  return {
    id: makeId(raw.sourceId, link),
    sourceId: raw.sourceId,
    kind: raw.kind || 'event',
    title,
    link,
    date: date || null,
    dateNormalized,
    dateEndNormalized,
    datePrecision,
    location: location || null,
    payment: cleanText(raw.payment) || null,
    tags,
    description: cleanText(raw.description) || null,
    company: cleanText(raw.company) || null,
    calendar: cleanText(raw.calendar) || null,
    firstSeenAt: raw.firstSeenAt || null,
  };
}
