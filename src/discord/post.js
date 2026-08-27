import { EmbedBuilder } from 'discord.js';

const kindColor = { event: 0x5865f2, job: 0x57f287 };

function toHashtag(tag) {
  const cleaned = tag.replace(/[^\p{L}\p{N}]+/gu, '');
  return cleaned ? `#${cleaned}` : null;
}

function formatDate(opportunity) {
  const { dateNormalized, dateEndNormalized, date } = opportunity;
  if (dateNormalized && dateEndNormalized) return `${dateNormalized} — ${dateEndNormalized}`;
  if (dateNormalized) return dateNormalized;
  return date || 'Дата не вказана';
}

/** Builds a Discord embed for one Opportunity (shape from src/lib/normalize.js). */
export function formatOpportunityEmbed(opportunity) {
  const embed = new EmbedBuilder()
    .setTitle(opportunity.title || 'Без назви')
    .setColor(kindColor[opportunity.kind] ?? 0x99aab5)
    .addFields(
      { name: 'Дата', value: formatDate(opportunity), inline: true },
      { name: 'Локація', value: opportunity.location || 'Не вказано', inline: true },
    );

  if (opportunity.link) embed.setURL(opportunity.link);
  if (opportunity.description) embed.setDescription(opportunity.description);
  if (opportunity.payment) embed.addFields({ name: 'Оплата', value: opportunity.payment, inline: true });
  if (opportunity.company) embed.addFields({ name: 'Компанія', value: opportunity.company, inline: true });
  const hashtags = (opportunity.tags || []).map(toHashtag).filter(Boolean).join(' ');
  if (hashtags) embed.addFields({ name: 'Теги', value: hashtags });
  if (opportunity.calendar) embed.addFields({ name: 'Календар', value: opportunity.calendar });

  return embed;
}

/**
 * Sends one Opportunity as an embed to DISCORD_CHANNEL_ID (or an explicit
 * channelId). `client` must already be logged in (see createDiscordClient).
 */
export async function postOpportunity(client, opportunity, { channelId = process.env.DISCORD_CHANNEL_ID } = {}) {
  if (!channelId) throw new Error('DISCORD_CHANNEL_ID is not set');

  const channel = await client.channels.fetch(channelId);
  return channel.send({ embeds: [formatOpportunityEmbed(opportunity)] });
}
