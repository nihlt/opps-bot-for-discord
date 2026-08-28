import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeId, parseDate, normalizeOpportunity, isFellowship, isHackathon, hasMoneyPrize, applyEventPaymentPolicy } from '../src/lib/normalize.js';

describe('makeId', () => {
  it('is stable for the same input', () => {
    const a = makeId('notion', 'https://example.com/a');
    const b = makeId('notion', 'https://example.com/a');
    assert.equal(a, b);
  });

  it('differs for a different link', () => {
    const a = makeId('notion', 'https://example.com/a');
    const b = makeId('notion', 'https://example.com/b');
    assert.notEqual(a, b);
  });

  it('differs for a different sourceId with the same link', () => {
    const a = makeId('notion', 'https://example.com/a');
    const b = makeId('dou-ai', 'https://example.com/a');
    assert.notEqual(a, b);
  });
});

describe('parseDate', () => {
  it('parses a Ukrainian single date', () => {
    const result = parseDate('18 червня 2026 року');
    assert.equal(result.dateNormalized, '2026-06-18');
    assert.equal(result.dateEndNormalized, null);
    assert.equal(result.datePrecision, 'date');
  });

  it('parses a Ukrainian date range', () => {
    const result = parseDate('18 — 20 червня 2026 року');
    assert.equal(result.dateNormalized, '2026-06-18');
    assert.equal(result.dateEndNormalized, '2026-06-20');
    assert.equal(result.datePrecision, 'date_range');
  });

  it('parses an English short date', () => {
    const result = parseDate('18 June 2026');
    assert.equal(result.dateNormalized, '2026-06-18');
    assert.equal(result.datePrecision, 'date');
  });

  it('parses a Kaggle-style datetime', () => {
    const result = parseDate('6/18/2026, 11:59:00 PM');
    assert.equal(result.dateNormalized, '2026-06-18T23:59:00');
    assert.equal(result.datePrecision, 'datetime');
  });

  it('parses an ISO date', () => {
    const result = parseDate('2026-06-18');
    assert.equal(result.dateNormalized, '2026-06-18');
    assert.equal(result.datePrecision, 'date');
  });

  it('returns unknown precision for unrecognized or empty input', () => {
    assert.equal(parseDate('').datePrecision, 'unknown');
    assert.equal(parseDate('not a date').datePrecision, 'unknown');
  });
});

describe('normalizeOpportunity', () => {
  it('produces the full Opportunity shape with a matching id', () => {
    const opp = normalizeOpportunity({
      sourceId: 'notion',
      title: 'Pie & AI: Kyiv',
      link: 'https://example.com/event',
      date: '18 червня 2026 року',
      location: 'Київ',
      payment: 'безкоштовно',
      tags: ['AI'],
      kind: 'event',
    });

    assert.equal(opp.id, makeId('notion', 'https://example.com/event'));
    assert.equal(opp.sourceId, 'notion');
    assert.equal(opp.kind, 'event');
    assert.equal(opp.title, 'Pie & AI: Kyiv');
    assert.equal(opp.link, 'https://example.com/event');
    assert.equal(opp.dateNormalized, '2026-06-18');
    assert.equal(opp.location, 'Київ');
    assert.equal(opp.payment, 'безкоштовно');
    assert.deepEqual(opp.tags, ['AI']);
  });

  it('defaults kind to "event" when not provided', () => {
    const opp = normalizeOpportunity({ sourceId: 'x', title: 't', link: 'https://x.test' });
    assert.equal(opp.kind, 'event');
  });

  it('sets link and calendar to null when absent instead of leaving them undefined', () => {
    const opp = normalizeOpportunity({ sourceId: 'x', title: 't' });
    assert.equal(opp.link, null);
    assert.equal(opp.calendar, null);
  });
});

describe('isFellowship', () => {
  it('matches on title', () => {
    assert.equal(isFellowship({ title: 'AI Fellowship 2026', tags: [], description: '' }), true);
  });

  it('matches Ukrainian "стипендія"', () => {
    assert.equal(isFellowship({ title: 'Стипендіальна програма', tags: [], description: '' }), true);
  });

  it('does not match an unrelated event', () => {
    assert.equal(isFellowship({ title: 'AI Hackathon', tags: ['AI'], description: 'A weekend hackathon.' }), false);
  });

  it('ignores a stray "grant" mention in the description of an unrelated event', () => {
    const opp = {
      title: 'UA Online Miltech Conference 2026',
      tags: [],
      description: 'Conference about aligning industry needs with available grants (гранти) and financing.',
    };
    assert.equal(isFellowship(opp), false);
  });
});

describe('isHackathon', () => {
  it('matches by dedicated sourceId', () => {
    assert.equal(isHackathon({ title: 'Something', tags: [], sourceId: 'dou-hackathon' }), true);
    assert.equal(isHackathon({ title: 'Something', tags: [], sourceId: 'kaggle' }), true);
  });

  it('matches by title/tag keyword, including the literal word "hackathon"', () => {
    assert.equal(isHackathon({ title: 'Global AI Hackathon', tags: [] }), true);
    assert.equal(isHackathon({ title: 'Спринт', tags: ['змагання'] }), true);
  });

  it('does not match an unrelated event', () => {
    assert.equal(isHackathon({ title: 'AI Meetup', tags: [] }), false);
  });
});

describe('hasMoneyPrize', () => {
  it('is true for a hackathon whose payment states a concrete amount', () => {
    const opp = { kind: 'event', sourceId: 'dou-hackathon', title: 'AI Hackathon', tags: [], payment: '500 000 грн', description: '' };
    assert.equal(hasMoneyPrize(opp), true);
  });

  it('is true for a fellowship whose description states a concrete amount', () => {
    const opp = { kind: 'event', sourceId: 'notion', title: 'AI Fellowship', tags: [], payment: null, description: '$1000 per student.' };
    assert.equal(hasMoneyPrize(opp), true);
  });

  it('is false for a fellowship/hackathon with no concrete figure anywhere', () => {
    const opp = { kind: 'event', sourceId: 'notion', title: 'AI Fellowship', tags: [], payment: 'funded', description: 'A generous stipend.' };
    assert.equal(hasMoneyPrize(opp), false);
  });

  it('is false for a generic event, even with a currency figure in its description', () => {
    const opp = { kind: 'event', sourceId: 'kse-news', title: 'AI Conference', tags: [], payment: null, description: 'Tickets cost $50.' };
    assert.equal(hasMoneyPrize(opp), false);
  });

  it('is false for a job, even one with a fellowship/hackathon-sounding title and a salary figure', () => {
    const opp = { kind: 'job', sourceId: 'djinni', title: 'AI Fellowship Coordinator', tags: [], payment: '$3000/month', description: '' };
    assert.equal(hasMoneyPrize(opp), false);
  });
});

describe('applyEventPaymentPolicy', () => {
  it('drops a paid course (event, cost to attend, not a fellowship)', () => {
    const opp = { kind: 'event', sourceId: 'dou-ai', title: 'AI Course', tags: [], description: '', payment: '$500' };
    assert.equal(applyEventPaymentPolicy(opp), null);
  });

  it('keeps a free event but clears the payment field', () => {
    const opp = { kind: 'event', sourceId: 'dou-ai', title: 'AI Meetup', tags: [], description: '', payment: 'безкоштовно' };
    const result = applyEventPaymentPolicy(opp);
    assert.notEqual(result, null);
    assert.equal(result.payment, null);
  });

  it('keeps a fellowship and preserves its payment amount', () => {
    const opp = { kind: 'event', sourceId: 'notion', title: 'AI Fellowship', tags: [], description: '', payment: '$1000/month' };
    const result = applyEventPaymentPolicy(opp);
    assert.notEqual(result, null);
    assert.equal(result.payment, '$1000/month');
  });

  it('exempts kaggle from the cost filter (payment is prize money)', () => {
    const opp = { kind: 'event', sourceId: 'kaggle', title: 'Kaggle Comp', tags: [], description: '', payment: '$50,000' };
    const result = applyEventPaymentPolicy(opp);
    assert.notEqual(result, null);
    assert.equal(result.payment, '$50,000');
  });

  it('keeps a hackathon (any source) and preserves its prize amount, same as a fellowship', () => {
    const opp = { kind: 'event', sourceId: 'dou-hackathon', title: 'AI Hackathon', tags: [], description: '', payment: '500 000 грн' };
    const result = applyEventPaymentPolicy(opp);
    assert.notEqual(result, null);
    assert.equal(result.payment, '500 000 грн');
  });

  it('leaves job listings untouched', () => {
    const opp = { kind: 'job', sourceId: 'djinni', title: 'AI Engineer', tags: [], description: '', payment: '$3000' };
    const result = applyEventPaymentPolicy(opp);
    assert.equal(result.payment, '$3000');
  });
});
