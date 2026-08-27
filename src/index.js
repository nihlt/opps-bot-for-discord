import 'dotenv/config';
import { createDiscordClient } from './discord/client.js';
import { runPipeline } from './pipeline.js';
import { startScheduler } from './scheduler.js';

async function main() {
  const client = await createDiscordClient();
  console.log(`[index] logged in as ${client.user.tag}`);

  await runPipeline(client);

  startScheduler(client);
  console.log(`[index] scheduler started (${process.env.CRON_SCHEDULE})`);
}

main().catch((error) => {
  console.error('[index] fatal error:', error);
  process.exit(1);
});
