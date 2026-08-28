import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveChannelTarget } from '../src/discord/target.js';

describe('resolveChannelTarget', () => {
  it('defaults to "test" when DISCORD_TARGET is unset', () => {
    assert.deepEqual(resolveChannelTarget({ TEST_DISCORD_CHANNEL_ID: 'test-id' }), {
      channelId: 'test-id',
      target: 'test',
    });
  });

  it('resolves DISCORD_CHANNEL_ID only when DISCORD_TARGET=prod is explicit', () => {
    assert.deepEqual(resolveChannelTarget({ DISCORD_TARGET: 'prod', DISCORD_CHANNEL_ID: 'prod-id' }), {
      channelId: 'prod-id',
      target: 'prod',
    });
  });

  it('ignores DISCORD_CHANNEL_ID when targeting test, even if both vars are set', () => {
    const result = resolveChannelTarget({
      TEST_DISCORD_CHANNEL_ID: 'test-id',
      DISCORD_CHANNEL_ID: 'prod-id',
    });
    assert.equal(result.channelId, 'test-id');
  });

  it('is case-insensitive on DISCORD_TARGET', () => {
    assert.equal(resolveChannelTarget({ DISCORD_TARGET: 'PROD', DISCORD_CHANNEL_ID: 'x' }).target, 'prod');
  });

  it('throws on an unrecognized DISCORD_TARGET value', () => {
    assert.throws(() => resolveChannelTarget({ DISCORD_TARGET: 'staging' }), /DISCORD_TARGET/);
  });

  it('throws a clear error naming TEST_DISCORD_CHANNEL_ID when targeting test without it set', () => {
    assert.throws(() => resolveChannelTarget({}), /TEST_DISCORD_CHANNEL_ID/);
  });

  it('throws a clear error naming DISCORD_CHANNEL_ID when targeting prod without it set', () => {
    assert.throws(() => resolveChannelTarget({ DISCORD_TARGET: 'prod' }), /DISCORD_CHANNEL_ID/);
  });
});
