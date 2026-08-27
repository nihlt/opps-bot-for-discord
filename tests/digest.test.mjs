import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitForDigest, postDigest } from '../src/discord/digest.js';

function opp(title) {
  return { title, kind: 'event', tags: [], location: '', description: '', link: `https://x.test/${title}` };
}

describe('splitForDigest', () => {
  it('puts at most 3 items in main, the rest in overflow', () => {
    const items = Array.from({ length: 7 }, (_, i) => opp(`item-${i}`));
    const { main, overflow } = splitForDigest(items);
    assert.equal(main.length, 3);
    assert.equal(overflow.length, 4);
  });

  it('sorts main+overflow by score descending', () => {
    const fellowship = { title: 'Fellowship', kind: 'event', tags: ['Fellowship'], location: '' };
    const generic = { title: 'Meetup', kind: 'event', tags: [], location: '' };
    const { main } = splitForDigest([generic, fellowship, generic]);
    assert.equal(main[0].title, 'Fellowship');
  });

  it('returns everything in main when the batch is small', () => {
    const items = [opp('a'), opp('b')];
    const { main, overflow } = splitForDigest(items);
    assert.equal(main.length, 2);
    assert.equal(overflow.length, 0);
  });
});

describe('postDigest', () => {
  function makeFakeChannel() {
    const sent = { main: null, thread: { created: null, messages: [] } };
    const fakeThread = {
      send: async (payload) => {
        sent.thread.messages.push(payload);
      },
    };
    const fakeMessage = {
      startThread: async (opts) => {
        sent.thread.created = opts;
        return fakeThread;
      },
    };
    const channel = {
      send: async (payload) => {
        sent.main = payload;
        return fakeMessage;
      },
    };
    return { channel, sent };
  }

  it('does nothing for an empty batch', async () => {
    const { channel, sent } = makeFakeChannel();
    const result = await postDigest(channel, []);
    assert.equal(result, null);
    assert.equal(sent.main, null);
  });

  it('sends only a main message when there are 3 or fewer items', async () => {
    const { channel, sent } = makeFakeChannel();
    await postDigest(channel, [opp('a'), opp('b')]);
    assert.ok(sent.main);
    assert.equal(sent.thread.created, null);
  });

  it('creates a thread and chunks overflow when there are more than 3 items', async () => {
    const { channel, sent } = makeFakeChannel();
    const items = Array.from({ length: 8 }, (_, i) => opp(`item-${i}`));
    await postDigest(channel, items);
    assert.ok(sent.main);
    assert.ok(sent.thread.created);
    assert.equal(sent.thread.created.name, 'Ще 5 можливостей');
    // 5 overflow items, chunk size 5 -> exactly one thread message
    assert.equal(sent.thread.messages.length, 1);
  });

  it('uses correct Ukrainian pluralization for the thread title', async () => {
    const { channel, sent } = makeFakeChannel();
    await postDigest(channel, Array.from({ length: 4 }, (_, i) => opp(`item-${i}`))); // 1 overflow
    assert.equal(sent.thread.created.name, 'Ще 1 можливість');
  });

  it('truncates a very long description so the message stays under Discord\'s 4000-char component text cap', async () => {
    const { channel, sent } = makeFakeChannel();
    const longDescription = 'a'.repeat(5000);
    await postDigest(channel, [{ ...opp('long'), description: longDescription }]);
    const payloadSize = JSON.stringify(sent.main.components).length;
    assert.ok(payloadSize < 4000, `expected payload under 4000 chars, got ${payloadSize}`);
    assert.ok(JSON.stringify(sent.main.components).includes('…'));
  });
});
