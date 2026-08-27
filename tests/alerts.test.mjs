import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { notifyAdmins } from '../src/discord/alerts.js';

const ORIGINAL_ENV = process.env.ADMIN_DISCORD_USER_IDS;

function fakeClient({ fetchImpl, sendImpl } = {}) {
  const sent = [];
  return {
    sent,
    client: {
      users: {
        fetch: async (id) => {
          if (fetchImpl) return fetchImpl(id);
          return {
            send: async (text) => {
              if (sendImpl) return sendImpl(id, text);
              sent.push({ id, text });
            },
          };
        },
      },
    },
  };
}

describe('notifyAdmins', () => {
  afterEach(() => {
    process.env.ADMIN_DISCORD_USER_IDS = ORIGINAL_ENV;
  });

  it('does nothing (no throw) when ADMIN_DISCORD_USER_IDS is unset', async () => {
    delete process.env.ADMIN_DISCORD_USER_IDS;
    const { client, sent } = fakeClient();
    await notifyAdmins(client, 'hello');
    assert.equal(sent.length, 0);
  });

  it('sends the message to every configured id', async () => {
    process.env.ADMIN_DISCORD_USER_IDS = '111, 222 ,333';
    const { client, sent } = fakeClient();
    await notifyAdmins(client, 'pipeline broke');
    assert.deepEqual(sent.map((s) => s.id), ['111', '222', '333']);
    assert.ok(sent.every((s) => s.text === 'pipeline broke'));
  });

  it('keeps going and never throws when one admin fetch/send fails', async () => {
    process.env.ADMIN_DISCORD_USER_IDS = '111,222';
    const sent = [];
    const client = {
      users: {
        fetch: async (id) => {
          if (id === '111') throw new Error('unknown user');
          return { send: async (text) => sent.push({ id, text }) };
        },
      },
    };
    await notifyAdmins(client, 'pipeline broke');
    assert.deepEqual(sent, [{ id: '222', text: 'pipeline broke' }]);
  });

  it('truncates a very long message', async () => {
    process.env.ADMIN_DISCORD_USER_IDS = '111';
    const { client, sent } = fakeClient();
    await notifyAdmins(client, 'a'.repeat(3000));
    assert.ok(sent[0].text.length <= 1901);
    assert.ok(sent[0].text.endsWith('…'));
  });
});
