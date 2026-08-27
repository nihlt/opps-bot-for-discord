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

  it('prefers opportunity.hook over the raw description when present', async () => {
    const { channel, sent } = makeFakeChannel();
    const hook = 'Learn to ship LLM agents to production in a weekend.';
    await postDigest(channel, [{ ...opp('hooked'), description: 'Generic promo filler about the venue.', hook }]);
    const payload = JSON.stringify(sent.main.components);
    assert.ok(payload.includes(hook));
    assert.ok(!payload.includes('Generic promo filler'));
  });

  it('keeps only the first 3 sentences of a longer description, not a mid-word chop', async () => {
    const { channel, sent } = makeFakeChannel();
    const description = 'One. Two. Three. Four should be dropped.';
    await postDigest(channel, [{ ...opp('sentences'), description }]);
    const payload = JSON.stringify(sent.main.components);
    assert.ok(payload.includes('One. Two. Three.'));
    assert.ok(!payload.includes('Four should be dropped'));
  });

  it('shows a location · score · better-than meta line under each item', async () => {
    const { channel, sent } = makeFakeChannel();
    const scoringPopulation = [opp('meta'), opp('lower'), opp('lower2')];
    await postDigest(channel, [{ ...opp('meta'), location: 'Lviv' }], { scoringPopulation });
    const payload = JSON.stringify(sent.main.components);
    assert.ok(payload.includes('Lviv · score'));
    assert.ok(/better than 0\.\d\d|one of the best/.test(payload));
  });

  it('says "one of the best" instead of a near-1.00 fraction for a top-decile item', async () => {
    const { channel, sent } = makeFakeChannel();
    const fellowship = { title: 'Fellowship', kind: 'event', tags: ['Fellowship'], location: '', description: '', link: 'https://x.test/f' };
    const scoringPopulation = [fellowship, ...Array.from({ length: 9 }, (_, i) => opp(`filler-${i}`))];
    await postDigest(channel, [fellowship], { scoringPopulation });
    const payload = JSON.stringify(sent.main.components);
    assert.ok(payload.includes('one of the best'));
    assert.ok(!payload.includes('better than 1.00'));
  });

  it('ranks against the full scoringPopulation, not just the posted batch', async () => {
    const { channel, sent } = makeFakeChannel();
    // A mediocre item that would look "top of the batch" if ranked only
    // against itself and one other mediocre item.
    const mediocre = opp('mediocre');
    const scoringPopulation = [
      mediocre,
      ...Array.from({ length: 9 }, (_, i) => ({
        title: `Fellowship ${i}`,
        kind: 'event',
        tags: ['Fellowship'],
        location: '',
        description: '',
        link: `https://x.test/fellowship-${i}`,
      })),
    ];
    await postDigest(channel, [mediocre, opp('other-mediocre')], { scoringPopulation });
    const payload = JSON.stringify(sent.main.components);
    // Ranked against 9 fellowships it's clearly bottom-tier, not "one of the best".
    assert.ok(!payload.includes('one of the best'));
  });
});
