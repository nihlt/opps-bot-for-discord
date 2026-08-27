import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Creates and logs in a Discord client using DISCORD_BOT_TOKEN from the
 * environment. Resolves once the client fires 'ready'.
 */
export async function createDiscordClient({ token = process.env.DISCORD_BOT_TOKEN } = {}) {
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const ready = new Promise((resolve) => {
    client.once('ready', () => resolve(client));
  });

  await client.login(token);
  return ready;
}
