import {
  MessageFlags,
  ThreadAutoArchiveDuration,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { scoreOpportunity } from '../lib/scoring.js';
import { isFellowship, isHackathon, hasMoneyPrize } from '../lib/normalize.js';
import { percentileColor } from './score-color.js';

const MAIN_MESSAGE_LIMIT = 3;
const THREAD_CHUNK_SIZE = 5;

// Display AND classification-priority order: an item that could fit more
// than one bucket (e.g. an online hackathon) resolves to whichever comes
// first in this list -- Jobs and Fellowship Programs are the most
// specific/unambiguous signals, so they're checked ahead of the two
// broader catch-alls (Online Events, Events).
const CATEGORY_ORDER = ['Hackathons', 'Events', 'Fellowship Programs', 'Jobs', 'Online Events'];
const onlineLocationPattern = /online|онлайн/i;

/** Which of CATEGORY_ORDER an opportunity belongs to -- see CATEGORY_ORDER's comment for priority. */
export function categorizeOpportunity(opportunity) {
  if (opportunity.kind === 'job') return 'Jobs';
  if (isFellowship(opportunity)) return 'Fellowship Programs';
  if (isHackathon(opportunity)) return 'Hackathons';
  if (onlineLocationPattern.test(opportunity.location || '')) return 'Online Events';
  return 'Events';
}
// Safety cap in case a generated summary runs long -- Components V2 caps
// a whole message's displayable text at 4000 chars, and with up to 5
// items per message this keeps each one bounded regardless.
const MAX_DESCRIPTION_LENGTH = 400;

function truncate(text, maxLength = MAX_DESCRIPTION_LENGTH) {
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function pluralizeOpportunity(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'можливість';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'можливості';
  return 'можливостей';
}

function divider() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

function categoryHeader(category) {
  return new TextDisplayBuilder().setContent(`**${category.toUpperCase()}**`);
}

const ukrainianMonthsGenitive = [
  'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];

function formatDigestDate(date) {
  return `${date.getDate()} ${ukrainianMonthsGenitive[date.getMonth()]}`;
}

// The one title line for the whole run's main message -- "Нові
// можливості за 28 серпня". No year: a daily digest never needs one to
// disambiguate, and the shorter form reads better as a title.
function titleHeader(date) {
  return new TextDisplayBuilder().setContent(`**Нові можливості за ${formatDigestDate(date)}**`);
}

function sourceDomain(link) {
  if (!link) return null;
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// "YYYY-MM-DD" -> "DD.MM" -- short by design, per explicit request; a
// year is rarely needed to disambiguate an upcoming deadline.
function formatShortDate(dateNormalized) {
  if (!dateNormalized) return null;
  const [, month, day] = dateNormalized.slice(0, 10).split('-');
  return `${day}.${month}`;
}

function itemContainer(opportunity, allScores) {
  const score = scoreOpportunity(opportunity);
  // The accent color still reflects the percentile band (gold top-10%,
  // gray ramp, none for the bottom half) -- only the visible "score N ·
  // better than 0.NN" text is gone, per explicit user request that the
  // raw number/percentile reads as noise rather than useful signal.
  const color = percentileColor(score, allScores);
  // `summary` (our own Gemini-generated one-liner) wins over `hook` (the
  // scheduled Claude agent's future field in Notion). Deliberately no
  // fallback to the raw scraped description -- that's promotional filler
  // from the source site, not what the reader actually gets, so if
  // summarization hasn't run or failed, showing nothing beats showing that.
  const description = truncate(opportunity.summary || opportunity.hook);
  const deadline = formatShortDate(opportunity.dateNormalized);
  const metaLine = [
    opportunity.location,
    sourceDomain(opportunity.link) && `from ${sourceDomain(opportunity.link)}`,
    deadline && `дедлайн: ${deadline}`,
  ]
    .filter(Boolean)
    .join(' · ');
  // Blank line between the description and the meta line, not just a
  // newline -- reads as two visually distinct pieces of information
  // rather than a run-on paragraph.
  const body = [description, metaLine].filter(Boolean).join('\n\n') || '—';

  // "· $" at the end of the title marks a hackathon/competition/fellowship
  // that states an actual money figure (see hasMoneyPrize() -- not a
  // job's salary, and not just any fellowship/hackathon, only ones with a
  // real number attached) -- a quick "this one pays" scan cue.
  const titleLine = hasMoneyPrize(opportunity) ? `**${opportunity.title}** · $` : `**${opportunity.title}**`;
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(titleLine));

  // A Discord Section requires an accessory (button or thumbnail) -- if
  // there's no link to send someone to, fall back to a plain text block
  // instead of a Section, rather than building a button with no URL.
  if (opportunity.link) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(opportunity.link).setLabel('Відкрити')),
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  }

  if (color !== null) container.setAccentColor(color);
  return container;
}

function buildComponents(items, allScores) {
  const components = [];
  items.forEach((item, index) => {
    components.push(itemContainer(item, allScores));
    if (index < items.length - 1) components.push(divider());
  });
  return components;
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

/**
 * Sorts by score descending; ties (common -- scoreOpportunity() only has
 * so many achievable values) break by earliest-discovered first, then by
 * title, so equal-score items land in a deliberate, explainable order
 * instead of whatever order they happened to survive filtering in.
 */
function sortByScoreDesc(opportunities) {
  return [...opportunities].sort((a, b) => {
    const scoreDiff = scoreOpportunity(b) - scoreOpportunity(a);
    if (scoreDiff !== 0) return scoreDiff;
    const aSeen = a.firstSeenAt ? Date.parse(a.firstSeenAt) : Infinity;
    const bSeen = b.firstSeenAt ? Date.parse(b.firstSeenAt) : Infinity;
    if (aSeen !== bSeen) return aSeen - bSeen;
    return (a.title || '').localeCompare(b.title || '');
  });
}

/**
 * Splits a batch into the GLOBAL top N (by score, descending, regardless
 * of category) for the main message, and everything else grouped by
 * CATEGORY_ORDER for thread display. Categories with no overflow items
 * are omitted entirely (no empty headers). Pure/testable without
 * touching Discord.
 */
export function splitDigestForPosting(opportunities, limit = MAIN_MESSAGE_LIMIT) {
  const sorted = sortByScoreDesc(opportunities);
  const main = sorted.slice(0, limit);
  const rest = sorted.slice(limit);

  const overflow = [];
  for (const category of CATEGORY_ORDER) {
    const items = rest.filter((o) => categorizeOpportunity(o) === category);
    if (items.length > 0) overflow.push({ category, items });
  }
  return { main, overflow };
}

/**
 * Posts a batch of opportunities as one digest: a single channel message
 * titled "Нові можливості за {date}" with the GLOBAL top 3 by score
 * (regardless of category) -- then, if there's more, one thread off that
 * message with everything else, grouped by CATEGORY_ORDER (Hackathons,
 * Events, Fellowship Programs, Jobs, Online Events), each category its
 * own chunked follow-up message(s) with its own header.
 *
 * Global top 3 in one message (not top-3-per-category) sidesteps
 * Discord's 40-component-per-message cap entirely -- that cap only bit
 * when an earlier design tried to fit every category's top 3 into one
 * combined message (~37 components for just two full categories). A
 * flat top 3 never gets close to that regardless of how many categories
 * exist.
 *
 * The accent color is a percentile against `scoringPopulation` (the
 * whole known catalogue, e.g. every stored Opportunity), NOT just the
 * handful of items being posted today -- ranking a small daily batch
 * against itself would be close to meaningless (a single mediocre item
 * could look "top 10%" of a batch of 3). Defaults to `opportunities`
 * itself only if no broader population is given (e.g. in tests, or a
 * first run with nothing else on record yet).
 */
export async function postDigest(channel, opportunities, { scoringPopulation = opportunities, date = new Date() } = {}) {
  if (opportunities.length === 0) return null;

  const allScores = scoringPopulation.map(scoreOpportunity);
  const { main, overflow } = splitDigestForPosting(opportunities);
  if (main.length === 0) return null;

  const mainMessage = await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [titleHeader(date), ...buildComponents(main, allScores)],
  });

  const overflowCount = overflow.reduce((sum, group) => sum + group.items.length, 0);
  if (overflowCount > 0) {
    const thread = await mainMessage.startThread({
      name: `Ще ${overflowCount} ${pluralizeOpportunity(overflowCount)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });

    for (const { category, items } of overflow) {
      for (const group of chunk(items, THREAD_CHUNK_SIZE)) {
        await thread.send({
          flags: MessageFlags.IsComponentsV2,
          components: [categoryHeader(category), ...buildComponents(group, allScores)],
        });
      }
    }
  }

  return mainMessage;
}
