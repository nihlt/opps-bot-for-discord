import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorizeOpportunity, splitForDigestByCategory, postDigest } from '../src/discord/digest.js';

function opp(title, overrides = {}) {
  return { title, kind: 'event', tags: [], location: '', description: '', link: `https://x.test/${title}`, ...overrides };
}

describe('categorizeOpportunity', () => {
  it('puts kind: job into Jobs regardless of title', () => {
    assert.equal(categorizeOpportunity({ kind: 'job', title: 'AI Fellowship Engineer', tags: [] }), 'Jobs');
  });

  it('puts a fellowship into Fellowship Programs', () => {
    assert.equal(categorizeOpportunity(opp('AI Fellowship 2026')), 'Fellowship Programs');
  });

  it('puts a hackathon (by sourceId) into Hackathons', () => {
    assert.equal(categorizeOpportunity(opp('Something', { sourceId: 'dou-hackathon' })), 'Hackathons');
  });

  it('puts a hackathon (by title/tag pattern) into Hackathons', () => {
    assert.equal(categorizeOpportunity(opp('Global AI Hackathon')), 'Hackathons');
    assert.equal(categorizeOpportunity(opp('Спринт', { tags: ['змагання'] })), 'Hackathons');
  });

  it('puts an online, non-fellowship, non-hackathon event into Online Events', () => {
    assert.equal(categorizeOpportunity(opp('AI Meetup', { location: 'Online' })), 'Online Events');
    assert.equal(categorizeOpportunity(opp('AI Meetup', { location: 'онлайн' })), 'Online Events');
  });

  it('falls back to Events for anything else', () => {
    assert.equal(categorizeOpportunity(opp('AI Meetup', { location: 'Lviv' })), 'Events');
  });

  it('resolves a fellowship+hackathon-titled item to Fellowship Programs (priority order)', () => {
    assert.equal(categorizeOpportunity(opp('AI Fellowship Hackathon')), 'Fellowship Programs');
  });

  it('resolves an online hackathon to Hackathons, not Online Events (priority order)', () => {
    assert.equal(categorizeOpportunity(opp('AI Hackathon', { location: 'Online' })), 'Hackathons');
  });
});

describe('splitForDigestByCategory', () => {
  it('groups items by category and caps each at 3 in main', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })),
      opp('meetup', { location: 'Lviv' }),
    ];
    const { main, overflow } = splitForDigestByCategory(items);
    const hackathons = main.find((g) => g.category === 'Hackathons');
    assert.equal(hackathons.items.length, 3);
    const hackathonOverflow = overflow.find((g) => g.category === 'Hackathons');
    assert.equal(hackathonOverflow.items.length, 2);
    assert.ok(main.find((g) => g.category === 'Events'));
  });

  it('omits categories with zero items entirely, from both main and overflow', () => {
    const { main, overflow } = splitForDigestByCategory([opp('meetup', { location: 'Lviv' })]);
    assert.deepEqual(main.map((g) => g.category), ['Events']);
    assert.equal(overflow.length, 0);
  });

  it('preserves CATEGORY_ORDER (Hackathons, Events, Fellowship Programs, Jobs, Online Events)', () => {
    const items = [
      { kind: 'job', title: 'AI Engineer', tags: [] },
      opp('AI Fellowship'),
      opp('AI Meetup', { location: 'Online' }),
      opp('AI Hackathon'),
      opp('AI Conference', { location: 'Kyiv' }),
    ];
    const { main } = splitForDigestByCategory(items);
    assert.deepEqual(main.map((g) => g.category), ['Hackathons', 'Events', 'Fellowship Programs', 'Jobs', 'Online Events']);
  });

  it('sorts each category by score descending', () => {
    const weak = opp('AI Meetup', { location: 'Kyiv' });
    const strong = opp('AI Meetup Lviv', { location: 'Lviv' });
    const { main } = splitForDigestByCategory([weak, strong]);
    const events = main.find((g) => g.category === 'Events');
    assert.equal(events.items[0].title, 'AI Meetup Lviv');
  });
});

describe('postDigest', () => {
  // Each category gets its OWN channel message (see postDigest's doc
  // comment: a single combined message hits Discord's 40-component cap
  // once more than ~2 categories are fully populated), so the fake
  // channel records an array of sent messages, each with its own
  // independent optional thread -- not one shared main/thread pair.
  function makeFakeChannel() {
    const sentMessages = [];
    const channel = {
      send: async (payload) => {
        const record = { payload, thread: null };
        sentMessages.push(record);
        return {
          startThread: async (opts) => {
            record.thread = { created: opts, messages: [] };
            return {
              send: async (threadPayload) => {
                record.thread.messages.push(threadPayload);
              },
            };
          },
        };
      },
    };
    return { channel, sentMessages };
  }

  function findByHeader(sentMessages, headerFragment) {
    return sentMessages.find((m) => JSON.stringify(m.payload.components).includes(headerFragment));
  }

  it('does nothing for an empty batch', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const result = await postDigest(channel, []);
    assert.equal(result, null);
    assert.equal(sentMessages.length, 0);
  });

  it('sends one message per non-empty category, each with only its own header', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    await postDigest(channel, [opp('AI Fellowship'), { kind: 'job', title: 'AI Engineer', tags: [] }]);
    assert.equal(sentMessages.length, 2);
    const fellowshipMsg = findByHeader(sentMessages, 'FELLOWSHIP PROGRAMS');
    const jobsMsg = findByHeader(sentMessages, 'JOBS');
    assert.ok(fellowshipMsg);
    assert.ok(jobsMsg);
    assert.ok(!JSON.stringify(fellowshipMsg.payload.components).includes('JOBS'));
  });

  it('sends only main messages, no threads, when every category has 3 or fewer items', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    await postDigest(channel, [opp('a', { location: 'Lviv' }), opp('b', { location: 'Kyiv' })]);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].thread, null);
  });

  it('creates a thread and chunks overflow for a category exceeding 3, independent of other categories', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const items = Array.from({ length: 8 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' }));
    await postDigest(channel, items);
    assert.equal(sentMessages.length, 1);
    const hackathonMsg = findByHeader(sentMessages, 'HACKATHONS');
    assert.equal(hackathonMsg.thread.created.name, 'Ще 5 можливостей');
    // 5 overflow items in one category, chunk size 5 -> exactly one thread message
    assert.equal(hackathonMsg.thread.messages.length, 1);
  });

  it('gives each category its own message and its own thread, never mixed', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const items = [
      ...Array.from({ length: 4 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })), // 1 overflow
      ...Array.from({ length: 4 }, (_, i) => ({ kind: 'job', title: `job-${i}`, tags: [] })), // 1 overflow
    ];
    await postDigest(channel, items);
    assert.equal(sentMessages.length, 2);
    const hackathonMsg = findByHeader(sentMessages, 'HACKATHONS');
    const jobsMsg = findByHeader(sentMessages, 'JOBS');
    assert.equal(hackathonMsg.thread.created.name, 'Ще 1 можливість');
    assert.equal(jobsMsg.thread.created.name, 'Ще 1 можливість');
  });

  it('truncates a very long summary so the message stays under Discord\'s 4000-char component text cap', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const longSummary = 'a'.repeat(5000);
    await postDigest(channel, [{ ...opp('long'), summary: longSummary }]);
    const payloadSize = JSON.stringify(sentMessages[0].payload.components).length;
    assert.ok(payloadSize < 4000, `expected payload under 4000 chars, got ${payloadSize}`);
    assert.ok(JSON.stringify(sentMessages[0].payload.components).includes('…'));
  });

  it('prefers opportunity.summary over opportunity.hook when both are present', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const summary = 'Ship an LLM agent end-to-end in a weekend.';
    await postDigest(channel, [{ ...opp('both'), summary, hook: 'stale hook text' }]);
    const payload = JSON.stringify(sentMessages[0].payload.components);
    assert.ok(payload.includes(summary));
    assert.ok(!payload.includes('stale hook text'));
  });

  it('falls back to hook when summary is absent', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const hook = 'Learn to ship LLM agents to production in a weekend.';
    await postDigest(channel, [{ ...opp('hooked'), hook }]);
    const payload = JSON.stringify(sentMessages[0].payload.components);
    assert.ok(payload.includes(hook));
  });

  it('never shows the raw scraped description, even with no summary or hook', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const description = 'Generic promotional filler about the venue and its thirteenth edition.';
    await postDigest(channel, [{ ...opp('plain'), description }]);
    const payload = JSON.stringify(sentMessages[0].payload.components);
    assert.ok(!payload.includes('Generic promotional filler'));
  });

  it('shows a location · from domain · score · better-than meta line under each item', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const scoringPopulation = [opp('meta', { location: 'Lviv' }), opp('lower'), opp('lower2')];
    await postDigest(
      channel,
      [{ ...opp('meta'), location: 'Lviv', link: 'https://dou.ua/calendar/1/' }],
      { scoringPopulation },
    );
    const payload = JSON.stringify(sentMessages[0].payload.components);
    assert.ok(payload.includes('Lviv · from dou.ua · score'));
    assert.ok(/better than 0\.\d\d|one of the best/.test(payload));
  });

  it('omits the "from domain" segment when the link is missing or unparseable', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    await postDigest(channel, [{ ...opp('nolink'), location: 'Lviv', link: null }]);
    const payload = JSON.stringify(sentMessages[0].payload.components);
    assert.ok(payload.includes('Lviv · score'));
    assert.ok(!payload.includes('from '));
  });

  it('puts a blank line between the description and the meta line', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    await postDigest(channel, [{ ...opp('spaced'), summary: 'A concrete sentence.' }]);
    const payload = JSON.parse(JSON.stringify(sentMessages[0].payload.components));
    // payload[0] is now the category header; the item container is payload[1]
    const text = payload[1].components[1].components[0].content;
    assert.ok(text.includes('A concrete sentence.\n\n'));
  });

  it('says "one of the best" instead of a near-1.00 fraction for a top-decile item', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    const fellowship = opp('Fellowship', { tags: ['Fellowship'] });
    const scoringPopulation = [fellowship, ...Array.from({ length: 9 }, (_, i) => opp(`filler-${i}`))];
    await postDigest(channel, [fellowship], { scoringPopulation });
    const payload = JSON.stringify(sentMessages[0].payload.components);
    assert.ok(payload.includes('one of the best'));
    assert.ok(!payload.includes('better than 1.00'));
  });

  it('ranks against the full scoringPopulation, not just the posted batch', async () => {
    const { channel, sentMessages } = makeFakeChannel();
    // A mediocre item that would look "top of the batch" if ranked only
    // against itself and one other mediocre item.
    const mediocre = opp('mediocre');
    const scoringPopulation = [
      mediocre,
      ...Array.from({ length: 9 }, (_, i) => opp(`Fellowship ${i}`, { tags: ['Fellowship'] })),
    ];
    await postDigest(channel, [mediocre, opp('other-mediocre')], { scoringPopulation });
    const payload = JSON.stringify(sentMessages[0].payload.components);
    // Ranked against 9 fellowships it's clearly bottom-tier, not "one of the best".
    assert.ok(!payload.includes('one of the best'));
  });
});
