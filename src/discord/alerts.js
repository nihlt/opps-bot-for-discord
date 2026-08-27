const MAX_DM_LENGTH = 1900;

function parseAdminIds() {
  return (process.env.ADMIN_DISCORD_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Sends a best-effort DM to every id in ADMIN_DISCORD_USER_IDS (comma-
 * separated). Never throws -- a failure to alert (DMs closed, no mutual
 * server with the bot, bad id) is logged and skipped, so calling this can
 * never mask or replace the original error it's reporting.
 */
export async function notifyAdmins(client, message) {
  const ids = parseAdminIds();
  if (ids.length === 0) {
    console.warn('[alerts] ADMIN_DISCORD_USER_IDS is not set, skipping alert:', message);
    return;
  }

  const text = message.length > MAX_DM_LENGTH ? `${message.slice(0, MAX_DM_LENGTH)}…` : message;

  for (const id of ids) {
    try {
      const user = await client.users.fetch(id);
      await user.send(text);
    } catch (error) {
      console.error(`[alerts] failed to DM admin ${id}:`, error.message);
    }
  }
}
