import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorizeOpportunity, splitDigestForPosting, postDigest } from '../src/discord/digest.js';

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

  it('puts a hackathon (by title keyword) into Hackathons', () => {
    assert.equal(categorizeOpportunity(opp('Global AI Hackathon')), 'Hackathons');
    assert.equal(categorizeOpportunity(opp('Весняне змагання з програмування')), 'Hackathons');
  });

  it('does not put a dou-competition-sourced item into Hackathons just from its source or tag', () => {
    // Regression: DOU's "змагання" calendar tags any competition, sports
    // races included -- only the item's own title is trusted (see
    // isHackathon() in lib/normalize.js).
    assert.equal(
      categorizeOpportunity(opp('Charity Run у Львові', { sourceId: 'dou-competition', tags: ['змагання'] })),
      'Events',
    );
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

describe('splitDigestForPosting', () => {
  it('takes the GLOBAL top 3 by score regardless of category, not top 3 per category', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })), // score 55 each
      opp('meetup', { location: 'Kyiv' }), // score 25, weaker
    ];
    const { main, overflow } = splitDigestForPosting(items);
    assert.equal(main.length, 3);
    assert.ok(main.every((o) => o.sourceId === 'dou-hackathon'));
    // 2 hackathons + the meetup end up in overflow, all under Hackathons/Events groups
    const overflowCount = overflow.reduce((sum, g) => sum + g.items.length, 0);
    assert.equal(overflowCount, 3);
  });

  it('groups overflow by CATEGORY_ORDER, omitting categories with nothing left over', () => {
    // 4 hackathons (score 55 each) outrank the one job (score 30), so the
    // job never makes the top 3 either -- both categories end up in
    // overflow, neither Events/Fellowship Programs/Online Events (empty).
    const items = [
      ...Array.from({ length: 4 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })),
      { kind: 'job', title: 'AI Engineer', tags: [] },
    ];
    const { overflow } = splitDigestForPosting(items);
    assert.deepEqual(overflow.map((g) => g.category), ['Hackathons', 'Jobs']);
  });

  it('preserves CATEGORY_ORDER across multiple overflow groups', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })),
      ...Array.from({ length: 4 }, (_, i) => ({ kind: 'job', title: `job-${i}`, tags: [] })),
    ];
    const { overflow } = splitDigestForPosting(items);
    assert.deepEqual(overflow.map((g) => g.category), ['Hackathons', 'Jobs']);
  });

  it('breaks an equal-score tie by earliest-discovered first, not incidental array order', () => {
    const later = opp('Zeta Meetup', { firstSeenAt: '2026-08-20T00:00:00.000Z' });
    const earlier = opp('Alpha Meetup', { firstSeenAt: '2026-08-10T00:00:00.000Z' });
    const { main } = splitDigestForPosting([later, earlier]);
    assert.equal(main[0].title, 'Alpha Meetup');
  });

  it('falls back to title alphabetical when scores tie and neither has a firstSeenAt', () => {
    const z = opp('Zeta Meetup');
    const a = opp('Alpha Meetup');
    const { main } = splitDigestForPosting([z, a]);
    assert.equal(main[0].title, 'Alpha Meetup');
  });
});

describe('postDigest', () => {
  // One main message (title + global top 3) and, if there's overflow, ONE
  // thread off of it, with category-grouped chunked follow-ups.
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

  it('sends a single main message titled with the date and the global top 3', async () => {
    const { channel, sent } = makeFakeChannel();
    const date = new Date('2026-08-28T12:00:00.000Z');
    await postDigest(channel, [opp('AI Fellowship'), { kind: 'job', title: 'AI Engineer', tags: [] }], { date });
    const components = JSON.parse(JSON.stringify(sent.main.components));
    assert.equal(components[0].content, '**Нові можливості за 28 серпня**');
    assert.equal(sent.thread.created, null);
  });

  it('defaults the title date to now when no date is given', async () => {
    const { channel, sent } = makeFakeChannel();
    const before = new Date();
    await postDigest(channel, [opp('AI Fellowship')]);
    const components = JSON.parse(JSON.stringify(sent.main.components));
    const months = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
    assert.equal(components[0].content, `**Нові можливості за ${before.getDate()} ${months[before.getMonth()]}**`);
  });

  it('sends only the main message, no thread, when there are 3 or fewer items total', async () => {
    const { channel, sent } = makeFakeChannel();
    await postDigest(channel, [opp('a', { location: 'Lviv' }), opp('b', { location: 'Kyiv' })]);
    assert.ok(sent.main);
    assert.equal(sent.thread.created, null);
  });

  it('creates one thread for everything beyond the global top 3, chunked and grouped by category', async () => {
    const { channel, sent } = makeFakeChannel();
    const items = [
      ...Array.from({ length: 6 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })), // 3 overflow
      ...Array.from({ length: 2 }, (_, i) => ({ kind: 'job', title: `job-${i}`, tags: [] })), // 2 overflow
    ];
    await postDigest(channel, items);
    assert.ok(sent.thread.created);
    assert.equal(sent.thread.created.name, 'Ще 5 можливостей');
    // one thread message for Hackathons overflow (3, under the 5-chunk size), one for Jobs overflow (2)
    assert.equal(sent.thread.messages.length, 2);
    const bodies = sent.thread.messages.map((m) => JSON.stringify(m.components));
    assert.ok(bodies.some((b) => b.includes('HACKATHONS') && !b.includes('JOBS')));
    assert.ok(bodies.some((b) => b.includes('JOBS') && !b.includes('HACKATHONS')));
  });

  it('chunks a single category\'s overflow at 5 per thread message', async () => {
    const { channel, sent } = makeFakeChannel();
    const items = Array.from({ length: 11 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })); // 3 main, 8 overflow
    await postDigest(channel, items);
    assert.equal(sent.thread.created.name, 'Ще 8 можливостей');
    // 8 items, chunk size 5 -> two thread messages (5 + 3), both under Hackathons
    assert.equal(sent.thread.messages.length, 2);
  });

  it('uses correct Ukrainian pluralization for the thread title', async () => {
    const { channel, sent } = makeFakeChannel();
    const items = Array.from({ length: 4 }, (_, i) => opp(`hack-${i}`, { sourceId: 'dou-hackathon' })); // 1 overflow
    await postDigest(channel, items);
    assert.equal(sent.thread.created.name, 'Ще 1 можливість');
  });

  it('truncates a very long summary so the message stays under Discord\'s 4000-char component text cap', async () => {
    const { channel, sent } = makeFakeChannel();
    const longSummary = 'a'.repeat(5000);
    await postDigest(channel, [{ ...opp('long'), summary: longSummary }]);
    const payloadSize = JSON.stringify(sent.main.components).length;
    assert.ok(payloadSize < 4000, `expected payload under 4000 chars, got ${payloadSize}`);
    assert.ok(JSON.stringify(sent.main.components).includes('…'));
  });

  it('prefers opportunity.summary over opportunity.hook when both are present', async () => {
    const { channel, sent } = makeFakeChannel();
    const summary = 'Ship an LLM agent end-to-end in a weekend.';
    await postDigest(channel, [{ ...opp('both'), summary, hook: 'stale hook text' }]);
    const payload = JSON.stringify(sent.main.components);
    assert.ok(payload.includes(summary));
    assert.ok(!payload.includes('stale hook text'));
  });

  it('falls back to hook when summary is absent', async () => {
    const { channel, sent } = makeFakeChannel();
    const hook = 'Learn to ship LLM agents to production in a weekend.';
    await postDigest(channel, [{ ...opp('hooked'), hook }]);
    const payload = JSON.stringify(sent.main.components);
    assert.ok(payload.includes(hook));
  });

  it('appends " · $" to the title for a hackathon/fellowship with a real prize figure', async () => {
    const { channel, sent } = makeFakeChannel();
    const payable = opp('AI Hackathon', { sourceId: 'dou-hackathon', payment: '500 000 грн' });
    await postDigest(channel, [payable]);
    const payload = JSON.parse(JSON.stringify(sent.main.components));
    // payload[0] is the title line, payload[1] the item container
    const titleText = payload[1].components[0].content;
    assert.equal(titleText, '**AI Hackathon** · $');
  });

  it('does not append " · $" when there is no concrete prize figure, or for a job', async () => {
    const { channel, sent } = makeFakeChannel();
    const noAmount = opp('AI Fellowship', { payment: 'funded' });
    await postDigest(channel, [noAmount, { kind: 'job', title: 'AI Engineer', tags: [], payment: '$3000' }]);
    assert.ok(!JSON.stringify(sent.main.components).includes('· $'));
  });

  it('never shows the raw scraped description, even with no summary or hook', async () => {
    const { channel, sent } = makeFakeChannel();
    const description = 'Generic promotional filler about the venue and its thirteenth edition.';
    await postDigest(channel, [{ ...opp('plain'), description }]);
    const payload = JSON.stringify(sent.main.components);
    assert.ok(!payload.includes('Generic promotional filler'));
  });

  it('shows a location · from domain · дедлайн meta line under each item, with no score/percentile text', async () => {
    const { channel, sent } = makeFakeChannel();
    const scoringPopulation = [opp('meta', { location: 'Lviv' }), opp('lower'), opp('lower2')];
    await postDigest(
      channel,
      [{ ...opp('meta'), location: 'Lviv', link: 'https://dou.ua/calendar/1/', dateNormalized: '2026-09-06' }],
      { scoringPopulation },
    );
    const payload = JSON.stringify(sent.main.components);
    assert.ok(payload.includes('Lviv · from dou.ua · дедлайн: 06.09'));
    // The raw score/percentile text was removed per explicit user request
    // (read as noise, not useful signal) -- only the accent color remains.
    assert.ok(!/\bscore \d/.test(payload));
    assert.ok(!/better than 0\.\d\d/.test(payload));
    assert.ok(!payload.includes('one of the best'));
  });

  it('omits the deadline segment when dateNormalized is missing', async () => {
    const { channel, sent } = makeFakeChannel();
    await postDigest(channel, [{ ...opp('nodate'), location: 'Lviv', link: null }]);
    const payload = JSON.parse(JSON.stringify(sent.main.components));
    const metaLine = payload[1].components[1].content;
    assert.equal(metaLine, 'Lviv');
  });

  it('omits the "from domain" segment when the link is missing or unparseable', async () => {
    const { channel, sent } = makeFakeChannel();
    await postDigest(channel, [{ ...opp('nolink'), location: 'Lviv', link: null }]);
    const payload = JSON.parse(JSON.stringify(sent.main.components));
    // No link -> no Section/button, just a plain text block (see
    // itemContainer's link-vs-no-link branch): components[1] is the body
    // TextDisplay directly, not nested inside a Section.
    const metaLine = payload[1].components[1].content;
    assert.equal(metaLine, 'Lviv');
  });

  it('puts a blank line between the description and the meta line', async () => {
    const { channel, sent } = makeFakeChannel();
    await postDigest(channel, [{ ...opp('spaced'), summary: 'A concrete sentence.' }]);
    const payload = JSON.parse(JSON.stringify(sent.main.components));
    // payload[0] title line, payload[1] item container
    const text = payload[1].components[1].components[0].content;
    assert.ok(text.includes('A concrete sentence.\n\n'));
  });

  // No score/percentile text is shown any more (removed per explicit user
  // request), but the accent color still reflects the percentile band --
  // these two check that wiring stayed intact via the color, not text.
  const GOLD_ACCENT = 0xc9a86b; // src/discord/score-color.js's GOLD

  it('gives a top-decile item the gold accent color', async () => {
    const { channel, sent } = makeFakeChannel();
    const fellowship = opp('Fellowship', { tags: ['Fellowship'] });
    const scoringPopulation = [fellowship, ...Array.from({ length: 9 }, (_, i) => opp(`filler-${i}`))];
    await postDigest(channel, [fellowship], { scoringPopulation });
    const payload = JSON.parse(JSON.stringify(sent.main.components));
    const itemContainerJson = payload[1]; // payload[0] is the title line
    assert.equal(itemContainerJson.accent_color, GOLD_ACCENT);
  });

  it('ranks against the full scoringPopulation, not just the posted batch', async () => {
    const { channel, sent } = makeFakeChannel();
    // A mediocre item that would look "top of the batch" if ranked only
    // against itself and one other mediocre item.
    const mediocre = opp('mediocre');
    const scoringPopulation = [
      mediocre,
      ...Array.from({ length: 9 }, (_, i) => opp(`Fellowship ${i}`, { tags: ['Fellowship'] })),
    ];
    await postDigest(channel, [mediocre, opp('other-mediocre')], { scoringPopulation });
    const payload = JSON.parse(JSON.stringify(sent.main.components));
    // Ranked against 9 fellowships both are clearly bottom-tier -- neither should be gold.
    const goldCount = payload.filter((component) => component.accent_color === GOLD_ACCENT).length;
    assert.equal(goldCount, 0);
  });
});
