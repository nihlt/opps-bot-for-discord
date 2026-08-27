import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeId, parseDate, normalizeOpportunity } from '../src/lib/normalize.js';

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
