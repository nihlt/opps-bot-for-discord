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
import { percentileColor } from './score-color.js';

const MAIN_MESSAGE_LIMIT = 3;
const THREAD_CHUNK_SIZE = 5;
// Components V2 caps a whole message's displayable text at 4000 chars;
// with up to 5 items per message this keeps every message safely under
// that regardless of how long a scraped description happens to be.
const MAX_DESCRIPTION_LENGTH = 300;

function truncate(text, maxLength) {
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

function itemContainer(opportunity, allScores) {
  const score = scoreOpportunity(opportunity);
  const color = percentileColor(score, allScores);
  const detailLine = [opportunity.location, opportunity.payment].filter(Boolean).join(' · ');
  const description = truncate(opportunity.description, MAX_DESCRIPTION_LENGTH);
  const body = [description, detailLine].filter(Boolean).join('\n') || '—';

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
 * that message, in chunks so no single follow-up gets too dense. Accent
 * color is percentile-based across the WHOLE batch passed in, not just
 * whichever items land in the main message.
 */
export async function postDigest(channel, opportunities) {
  if (opportunities.length === 0) return null;

  const allScores = opportunities.map(scoreOpportunity);
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
