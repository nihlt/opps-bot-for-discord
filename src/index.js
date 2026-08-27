import 'dotenv/config';
import { createDiscordClient } from './discord/client.js';
import { runPipeline } from './pipeline.js';
import { notifyAdmins } from './discord/alerts.js';

let client;

/**
 * Runs once and exits -- GitHub Actions' own schedule trigger is the
 * scheduler now (see .github/workflows/daily-digest.yml), so there's no
 * reason to keep a long-lived process/cron loop around.
 */
async function main() {
  client = await createDiscordClient();
  console.log(`[index] logged in as ${client.user.tag}`);

  await runPipeline(client);

  await client.destroy();
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[index] fatal error:', error);
    // Best-effort only: if createDiscordClient() itself is what failed, there
    // is no logged-in client to send a DM through -- Discord can't alert
    // about Discord being unreachable. GitHub Actions' own "workflow run
    // failed" email covers exactly that gap from the infrastructure side.
    if (client) await notifyAdmins(client, `[opps-bot] Fatal error: ${error.message}`).catch(() => {});
    process.exit(1);
  });
