import { isFellowship } from './normalize.js';

const lvivPattern = /львів|lviv/i;
const onlinePattern = /online|онлайн|remote|віддалено/i;
const aiFitPattern = /\bAI\b|\bML\b|\bNLP\b|machine learning|artificial intelligence|штучн\p{L}*\s+інтелект/iu;
const hackathonSources = new Set(['dou-hackathon', 'dou-competition', 'kaggle']);
const hackathonTagPattern = /хакатон|змагання|competition|hackathon/i;
const internshipTagPattern = /intern/i;

/**
 * True when the opportunity is a hackathon/competition -- either scraped
 * from a source dedicated to those (dou-hackathon, dou-competition,
 * kaggle) or self-described as one in its own title/tags. Exported
 * separately from scoreOpportunity() so digest.js's category grouping
 * (see discord/digest.js) always agrees with the score bump below --
 * one definition, not two that could drift apart.
 */
export function isHackathon(opportunity) {
  const titleAndTags = [opportunity.title || '', (opportunity.tags || []).join(' ')].join(' ');
  return hackathonSources.has(opportunity.sourceId) || hackathonTagPattern.test(titleAndTags);
}
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
 *     target audience; near-zero experience required is rewarded.
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
  const locationText = [location, title, description].join(' ');

  let score;
  if (opportunity.kind === 'job') {
    score = 30;
    const years = parseYearsOfExperience(location) ?? (noExperiencePattern.test(location) ? 0 : null);
    if (years !== null) {
      if (years <= 0.5) score += 15;
      else if (years >= 2) score -= 15;
    }
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
