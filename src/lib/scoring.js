import { isFellowship, isHackathon } from './normalize.js';

const lvivPattern = /львів|lviv/i;
const onlinePattern = /online|онлайн|remote|віддалено/i;
const aiFitPattern = /\bAI\b|\bML\b|\bNLP\b|machine learning|artificial intelligence|штучн\p{L}*\s+інтелект/iu;
const internshipTagPattern = /intern/i;
const noExperiencePattern = /no[_\s]?exp/i;

/**
 * Extracts a leading years-of-experience number from free text like
 * "0.5 років досвіду" or "1 рік досвіду" ("рік" nominative vs. the
 * "рок-" stem shared by "року"/"років"/"роки" are different words, so
 * both alternatives are needed). Returns null when no such number is found.
 */
function parseYearsOfExperience(text) {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:рік|рок)/i);
  return match ? parseFloat(match[1].replace(',', '.')) : null;
}

/**
 * A finer step function than a flat "<=0.5 good, >=2 bad" -- djinni's own
 * experience buckets cluster heavily around "1 рік", which used to land
 * everyone in a single flat +0 tier alongside every other 0.5-2 year
 * posting. Smoothing this into 4 steps instead of 3 spreads out what
 * used to be a tie.
 */
function yearsOfExperienceBonus(years) {
  if (years <= 0.5) return 15;
  if (years < 1.5) return 8;
  if (years < 2) return 0;
  return -15;
}

const englishLevelPattern = /англійська\s*-\s*(немає|a1|a2|b1|b2|c1|c2)/i;

/**
 * djinni's job cards include a required-English-level segment in the
 * same free-text field as work format/experience (see
 * scoreOpportunity's `location` comment). Lower requirement is more
 * accessible for a 1st-4th-year student, so it's treated as a genuine
 * fit signal, not decoration -- and it happens to be the one axis that
 * actually varies across otherwise-identical-looking junior/trainee
 * postings (see the "Strong Junior AI Engineer" / "Trainee AI Business
 * Analyst" example that motivated this: same experience bucket, same
 * remote status, different English bar).
 */
function englishLevelBonus(location) {
  const match = (location || '').match(englishLevelPattern);
  if (!match) return 0;
  switch (match[1].toLowerCase()) {
    case 'немає':
    case 'a1':
    case 'a2':
      return 10;
    case 'b1':
      return 5;
    case 'b2':
      return 0;
    default: // c1, c2
      return -10;
  }
}

/**
 * Heuristic 0-100 "worth your attention" score, aimed at LPNU Computer
 * Science / AI Systems undergrads (years 1-4). It approximates a
 * result-for-effort ratio:
 *   - result: fellowships/stipends (paid + prestige) score highest;
 *     internships and hackathons/competitions (prize + resume) tie for
 *     second; generic events last. Jobs are scored separately since "result" for
 *     a job is a salary a 1st-4th-year student usually can't access yet.
 *   - effort: an event in Lviv (the department's home city — zero travel)
 *     is the single biggest bonus; online/remote is a smaller one, since
 *     it's convenient but not "walk to class" convenient. A job asking
 *     for 2+ years of experience is penalized as a poor fit for the
 *     target audience; near-zero experience required is rewarded, with a
 *     smoothed 4-step curve (not a flat 3-way split) since djinni jobs
 *     cluster heavily around "1 рік" and used to tie there. A job's
 *     required English level (also scraped into `location`, see
 *     englishLevelBonus()) is a second job-only signal, on the same
 *     accessibility logic — Lviv/online scanning doesn't reliably apply
 *     to jobs at all, since `location` there isn't a place (see below).
 * Calibrated against the first 167-item scrape: ~10% land at the top.
 * Pass an opportunity that has already gone through
 * applyEventPaymentPolicy (paid, non-fellowship courses/events should
 * already be filtered out before this ever runs).
 */
export function scoreOpportunity(opportunity) {
  const title = opportunity.title || '';
  const description = opportunity.description || '';
  const location = opportunity.location || '';
  const tags = opportunity.tags || [];
  const titleAndTags = [title, tags.join(' ')].join(' ');
  const fitText = [title, description, tags.join(' ')].join(' ');
  // For jobs, `location` isn't a place -- djinni packs "work format,
  // experience, English level, industry" into it, and the description is
  // free-text job-ad copy. Scanning that description for "Lviv" mentions
  // is a coin flip (most on-site postings never name the city in the
  // blurb we scrape), so it's excluded for jobs -- the flat unreliable
  // hit isn't worth keeping just because it's occasionally right.
  const locationText = opportunity.kind === 'job' ? [location, title].join(' ') : [location, title, description].join(' ');

  let score;
  if (opportunity.kind === 'job') {
    score = 30;
    const years = parseYearsOfExperience(location) ?? (noExperiencePattern.test(location) ? 0 : null);
    if (years !== null) score += yearsOfExperienceBonus(years);
    score += englishLevelBonus(location);
  } else if (isFellowship(opportunity)) {
    score = 65;
  } else if (tags.some((tag) => internshipTagPattern.test(tag))) {
    score = 55;
  } else if (isHackathon(opportunity)) {
    score = 55;
  } else {
    score = 25;
  }

  if (lvivPattern.test(locationText)) score += 25;
  else if (onlinePattern.test(locationText)) score += 10;

  if (aiFitPattern.test(fitText)) score += 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * The score actually used for ranking/display (see digest.js, notion-feed.js)
 * -- averages the heuristic score above with the LLM's own 0-100
 * `relevanceScore` (see lib/summarize.js), when one is available. An item
 * the LLM vetoed (`relevant: false`) is filtered out upstream before this
 * ever runs (see pipeline.js), so this function never needs to special-case
 * a veto itself. `relevanceScore` is `null` (not e.g. a fabricated 50)
 * whenever the LLM had no opinion -- an outage, or a model response that
 * omitted it -- so falling back to the heuristic alone here is the correct
 * "no information to blend" behavior, not a lossy default.
 */
export function finalScore(opportunity) {
  const heuristic = scoreOpportunity(opportunity);
  if (opportunity.relevanceScore == null) return heuristic;
  return Math.round((heuristic + opportunity.relevanceScore) / 2);
}
