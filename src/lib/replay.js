const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for a Date, in UTC -- matches how firstSeenAt (an ISO/UTC timestamp) is bucketed by day. */
export function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Parses a replay start-date argument into a "YYYY-MM-DD" key. Accepts
 * either the short "DD.MM" form (matching this codebase's existing
 * short-date display convention, see formatShortDate() in digest.js) or a
 * full "YYYY-MM-DD". "DD.MM" has no year, so it assumes `referenceDate`'s
 * (UTC) year -- and if that lands in the future relative to `referenceDate`
 * (e.g. running "20.12" in January), rolls back one year rather than
 * producing a start date after today.
 */
export function parseDayKeyArg(input, referenceDate = new Date()) {
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((input || '').trim());
  const shortMatch = /^(\d{1,2})\.(\d{1,2})$/.exec((input || '').trim());

  let year, month, day;
  if (isoMatch) {
    [, year, month, day] = isoMatch;
  } else if (shortMatch) {
    [, day, month] = shortMatch;
    year = String(referenceDate.getUTCFullYear());
  } else {
    throw new Error(`Unrecognized date "${input}" -- expected DD.MM or YYYY-MM-DD`);
  }

  let key = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const roundTrip = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(roundTrip.getTime()) || roundTrip.toISOString().slice(0, 10) !== key) {
    throw new Error(`Invalid date "${input}"`);
  }

  if (shortMatch && key > utcDateKey(referenceDate)) {
    key = `${Number(year) - 1}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return key;
}

/** Every "YYYY-MM-DD" key from startKey to endKey, inclusive. Throws if startKey is after endKey. */
export function dayKeyRange(startKey, endKey) {
  if (startKey > endKey) throw new Error(`start date ${startKey} is after end date ${endKey}`);
  const keys = [];
  let cursor = Date.parse(`${startKey}T00:00:00Z`);
  const end = Date.parse(`${endKey}T00:00:00Z`);
  while (cursor <= end) {
    keys.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return keys;
}

/**
 * Buckets a catalogue by the calendar day (UTC) of each item's
 * firstSeenAt -- i.e. the same "genuinely new that day" set a real daily
 * run would have posted. Items with no firstSeenAt are excluded (can't
 * place them on a specific day), same as withinLookbackWindow() in
 * pipeline.js.
 */
export function groupOpportunitiesByDay(catalogue) {
  const byDay = new Map();
  for (const opportunity of catalogue) {
    if (!opportunity.firstSeenAt) continue;
    const key = opportunity.firstSeenAt.slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(opportunity);
  }
  return byDay;
}

// Local (no "Z"), at midday -- so getDate()/getMonth() (what digest.js's
// titleHeader() reads) resolve to the intended calendar day regardless of
// the runner's timezone, with no risk of a midnight DST transition
// shifting it by one.
export function dayKeyToDisplayDate(dayKey) {
  return new Date(`${dayKey}T12:00:00`);
}

/** "YYYY-MM-DD" -> "DD.MM" -- the short form used in the replay's own admin-DM context tag. */
export function dayKeyToShort(dayKey) {
  const [, month, day] = dayKey.split('-');
  return `${day}.${month}`;
}
