import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  utcDateKey,
  parseDayKeyArg,
  dayKeyRange,
  groupOpportunitiesByDay,
  dayKeyToDisplayDate,
  dayKeyToShort,
} from '../src/lib/replay.js';

describe('utcDateKey', () => {
  it('formats a Date as YYYY-MM-DD in UTC', () => {
    assert.equal(utcDateKey(new Date('2026-08-20T23:30:00Z')), '2026-08-20');
  });
});

describe('parseDayKeyArg', () => {
  const reference = new Date('2026-08-28T12:00:00Z');

  it('parses DD.MM using the reference year', () => {
    assert.equal(parseDayKeyArg('20.08', reference), '2026-08-20');
  });

  it('parses a single-digit DD.MM', () => {
    assert.equal(parseDayKeyArg('5.8', reference), '2026-08-05');
  });

  it('parses a full YYYY-MM-DD unchanged', () => {
    assert.equal(parseDayKeyArg('2026-08-20', reference), '2026-08-20');
  });

  it('rolls a DD.MM that would land in the future back one year', () => {
    // "20.12" against a late-August reference would be 2026-12-20, which
    // is after the reference date -- so it must mean last December.
    assert.equal(parseDayKeyArg('20.12', reference), '2025-12-20');
  });

  it('rejects an unrecognized format', () => {
    assert.throws(() => parseDayKeyArg('August 20', reference));
  });

  it('rejects a calendar-invalid date', () => {
    assert.throws(() => parseDayKeyArg('31.02', reference));
  });
});

describe('dayKeyRange', () => {
  it('is inclusive of both endpoints', () => {
    assert.deepEqual(dayKeyRange('2026-08-26', '2026-08-28'), ['2026-08-26', '2026-08-27', '2026-08-28']);
  });

  it('returns a single day when start equals end', () => {
    assert.deepEqual(dayKeyRange('2026-08-28', '2026-08-28'), ['2026-08-28']);
  });

  it('throws when start is after end', () => {
    assert.throws(() => dayKeyRange('2026-08-28', '2026-08-20'));
  });
});

describe('groupOpportunitiesByDay', () => {
  it('buckets items by the UTC calendar day of firstSeenAt', () => {
    const catalogue = [
      { id: '1', firstSeenAt: '2026-08-20T09:00:00.000Z' },
      { id: '2', firstSeenAt: '2026-08-20T23:59:00.000Z' },
      { id: '3', firstSeenAt: '2026-08-21T00:00:01.000Z' },
    ];
    const byDay = groupOpportunitiesByDay(catalogue);
    assert.deepEqual(byDay.get('2026-08-20').map((o) => o.id), ['1', '2']);
    assert.deepEqual(byDay.get('2026-08-21').map((o) => o.id), ['3']);
  });

  it('excludes items with no firstSeenAt', () => {
    const byDay = groupOpportunitiesByDay([{ id: '1' }]);
    assert.equal(byDay.size, 0);
  });
});

describe('dayKeyToDisplayDate', () => {
  it('produces a Date whose local getDate()/getMonth() match the key', () => {
    const date = dayKeyToDisplayDate('2026-08-20');
    assert.equal(date.getDate(), 20);
    assert.equal(date.getMonth(), 7); // August, 0-indexed
  });
});

describe('dayKeyToShort', () => {
  it('formats YYYY-MM-DD as DD.MM', () => {
    assert.equal(dayKeyToShort('2026-08-08'), '08.08');
    assert.equal(dayKeyToShort('2026-01-31'), '31.01');
  });
});
