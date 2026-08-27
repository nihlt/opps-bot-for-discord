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
import { percentileColor, percentileOf } from './score-color.js';

const MAIN_MESSAGE_LIMIT = 3;
const THREAD_CHUNK_SIZE = 5;
const MAX_DESCRIPTION_SENTENCES = 3;
// Fallback safety net for text with no sentence-ending punctuation at
// all -- Components V2 caps a whole message's displayable text at 4000
// chars, and with up to 5 items per message this keeps each one bounded
// regardless of how long a scraped description happens to be.
const MAX_DESCRIPTION_LENGTH = 400;

/** Takes the first 1-3 sentences of a description for context, not a mid-word chop. */
function firstSentences(text, maxSentences = MAX_DESCRIPTION_SENTENCES, maxLength = MAX_DESCRIPTION_LENGTH) {
  if (!text) return null;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [text];
  const picked = sentences.slice(0, maxSentences).join('').trim() || text.trim();
  return picked.length > maxLength ? `${picked.slice(0, maxLength)}…` : picked;
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

const TOP_PERCENTILE_LABEL = 0.9;

function percentileLabel(percentile) {
  // A "better than 1.00" is a real number but reads as a bug -- past the
  // top-decile cutoff (the same one that drives the gold accent), just
  // say it's one of the best rather than showing a number pinned near 1.
  return percentile >= TOP_PERCENTILE_LABEL ? 'one of the best' : `better than ${percentile.toFixed(2)}`;
}

function itemContainer(opportunity, allScores) {
  const score = scoreOpportunity(opportunity);
  const percentile = percentileOf(score, allScores);
  const color = percentileColor(score, allScores);
  // `hook` isn't part of our own scraped Opportunity shape -- it's a
  // one-sentence concrete-benefit blurb the scheduled Claude scoring
  // agent writes into Notion's "Hook" property alongside Score. Once
  // there's a step that reads that back and attaches it here, it wins
  // over the raw scraped description (which is usually promotional
  // filler from the source site, not what the reader actually gets).
  const description = opportunity.hook || firstSentences(opportunity.description);
  const metaLine = [opportunity.location, `score ${score}`, percentileLabel(percentile)].filter(Boolean).join(' · ');
  const body = [description, metaLine].filter(Boolean).join('\n') || '—';

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${opportunity.title}**`))
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(opportunity.link).setLabel('Відкрити')),
    );

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
 * Splits a batch into the top N (by score, descending) for the main
 * message and the rest as thread overflow. Pure/testable without touching
 * Discord.
 */
export function splitForDigest(opportunities, limit = MAIN_MESSAGE_LIMIT) {
  const sorted = [...opportunities].sort((a, b) => scoreOpportunity(b) - scoreOpportunity(a));
  return { main: sorted.slice(0, limit), overflow: sorted.slice(limit) };
}

/**
 * Posts a batch of opportunities as a digest: at most 3 (by score) go in
 * the channel message itself; everything else is pushed into a thread off
 * that message, in chunks so no single follow-up gets too dense.
 *
 * The accent color and "better than 0.NN" figure are percentiles against
 * `scoringPopulation` (the whole known catalogue, e.g. every stored
 * Opportunity), NOT just the handful of items being posted today --
 * ranking a small daily batch against itself would be close to
 * meaningless (a single mediocre item could look "top 10%" of a batch of
 * 3). Defaults to `opportunities` itself only if no broader population is
 * given (e.g. in tests, or a first run with nothing else on record yet).
 */
export async function postDigest(channel, opportunities, { scoringPopulation = opportunities } = {}) {
  if (opportunities.length === 0) return null;

  const allScores = scoringPopulation.map(scoreOpportunity);
  const { main, overflow } = splitForDigest(opportunities);

  const mainMessage = await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: buildComponents(main, allScores),
  });

  if (overflow.length > 0) {
    const thread = await mainMessage.startThread({
      name: `Ще ${overflow.length} ${pluralizeOpportunity(overflow.length)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });

    for (const group of chunk(overflow, THREAD_CHUNK_SIZE)) {
      await thread.send({
        flags: MessageFlags.IsComponentsV2,
        components: buildComponents(group, allScores),
      });
    }
  }

  return mainMessage;
}
