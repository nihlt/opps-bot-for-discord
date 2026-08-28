/**
 * Resolves which Discord channel an invocation should actually post to.
 * Default is always "test" -- reaching the real production channel
 * requires deliberately setting DISCORD_TARGET=prod, which only
 * .github/workflows/daily-digest.yml's scheduled step does. A local run
 * with a bare .env (DISCORD_TARGET unset, or set to anything but "prod")
 * can never reach prod by accident.
 *
 * Takes an `env` object (defaults to process.env) rather than reading
 * process.env internally, so it's testable without touching global state.
 */
export function resolveChannelTarget(env = process.env) {
  const target = (env.DISCORD_TARGET || 'test').toLowerCase();
  if (target !== 'test' && target !== 'prod') {
    throw new Error(`DISCORD_TARGET must be "test" or "prod", got "${env.DISCORD_TARGET}"`);
  }

  const varName = target === 'prod' ? 'DISCORD_CHANNEL_ID' : 'TEST_DISCORD_CHANNEL_ID';
  const channelId = env[varName];
  if (!channelId) throw new Error(`${varName} is not set (DISCORD_TARGET=${target})`);

  return { channelId, target };
}
