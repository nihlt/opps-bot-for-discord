import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreOpportunity, finalScore } from '../src/lib/scoring.js';

describe('scoreOpportunity', () => {
  it('scores a fellowship highest among event kinds', () => {
    const fellowship = scoreOpportunity({ kind: 'event', title: 'AI Fellowship', tags: [], location: 'Remote' });
    const hackathon = scoreOpportunity({ kind: 'event', title: 'AI Hackathon', tags: [], sourceId: 'dou-hackathon', location: 'Online' });
    const genericEvent = scoreOpportunity({ kind: 'event', title: 'AI Meetup', tags: [], location: 'Kyiv' });
    assert.ok(fellowship > hackathon);
    assert.ok(hackathon > genericEvent);
  });

  it('gives a large bonus to Lviv location over online, and online over elsewhere', () => {
    const lviv = scoreOpportunity({ kind: 'event', title: 'AI Meetup', tags: [], location: 'Львів' });
    const online = scoreOpportunity({ kind: 'event', title: 'AI Meetup', tags: [], location: 'Online' });
    const elsewhere = scoreOpportunity({ kind: 'event', title: 'AI Meetup', tags: [], location: 'Kyiv' });
    assert.ok(lviv > online);
    assert.ok(online > elsewhere);
  });

  it('rewards a low-experience-requirement job and penalizes a high-experience one', () => {
    const junior = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '0.5 років досвіду' });
    const baseline = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '1 рік досвіду' });
    const senior = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '3 роки досвіду' });
    assert.ok(junior > baseline);
    assert.ok(baseline > senior);
  });

  it('rewards a lower required English level for a job, penalizes a high one', () => {
    const none = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '1 рік досвіду, Англійська - Немає' });
    const b1 = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '1 рік досвіду, Англійська - B1' });
    const b2 = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '1 рік досвіду, Англійська - B2' });
    const c1 = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '1 рік досвіду, Англійська - C1' });
    assert.ok(none > b1 && b1 > b2 && b2 > c1);
  });

  it('does not scan a job description for Lviv -- unlike an event, where location is a real place, a job posting\'s location field is work-format/experience/English text, and mentioning the office city in ad copy is not a reliable signal', () => {
    const officeJob = scoreOpportunity({
      kind: 'job',
      title: 'AI Engineer',
      location: 'Тільки офіс, 1 рік досвіду, Англійська - B2',
      description: 'This role requires working on-site at our Lviv office.',
    });
    const sameJobNoDescription = scoreOpportunity({
      kind: 'job',
      title: 'AI Engineer',
      location: 'Тільки офіс, 1 рік досвіду, Англійська - B2',
    });
    assert.equal(officeJob, sameJobNoDescription);
  });

  it('still scans an event\'s description for Lviv (unlike jobs)', () => {
    const withLviv = scoreOpportunity({ kind: 'event', title: 'AI Meetup', tags: [], location: '', description: 'Join us at our Lviv venue.' });
    const without = scoreOpportunity({ kind: 'event', title: 'AI Meetup', tags: [], location: '', description: 'Join us online.' });
    assert.ok(withLviv > without);
  });

  it('smooths the experience-years bonus into more than 3 steps so jobs clustered around "1 рік" spread out', () => {
    const halfYear = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '0.5 років досвіду' });
    const oneYear = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '1 рік досвіду' });
    const oneAndHalf = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '1.5 років досвіду' });
    const twoYears = scoreOpportunity({ kind: 'job', title: 'AI Engineer', location: '2 роки досвіду' });
    assert.ok(halfYear > oneYear && oneYear > oneAndHalf && oneAndHalf > twoYears);
  });

  it('stays within 0-100', () => {
    const score = scoreOpportunity({ kind: 'event', title: 'AI Fellowship', tags: [], location: 'Львів' });
    assert.ok(score <= 100 && score >= 0);
  });

  it('calibrates so roughly the top 10% of a realistic mixed batch clears a high bar', () => {
    const batch = [
      ...Array.from({ length: 15 }, (_, i) => ({ kind: 'event', title: `Fellowship ${i}`, tags: [], location: 'Remote' })),
      ...Array.from({ length: 130 }, (_, i) => ({ kind: 'event', title: `Meetup ${i}`, tags: [], location: 'Kyiv' })),
    ];
    const scores = batch.map(scoreOpportunity).sort((a, b) => b - a);
    const top10pct = Math.ceil(batch.length * 0.1);
    assert.ok(scores[top10pct - 1] >= 60, `expected top decile to score >= 60, got ${scores[top10pct - 1]}`);
  });
});

describe('finalScore', () => {
  it('equals scoreOpportunity when there is no relevanceScore (no LLM opinion)', () => {
    const opportunity = { kind: 'event', title: 'AI Hackathon', tags: [], location: 'Львів' };
    assert.equal(finalScore(opportunity), scoreOpportunity(opportunity));
  });

  it('equals scoreOpportunity when relevanceScore is explicitly null', () => {
    const opportunity = { kind: 'event', title: 'AI Hackathon', tags: [], location: 'Львів', relevanceScore: null };
    assert.equal(finalScore(opportunity), scoreOpportunity(opportunity));
  });

  it('averages the heuristic score with relevanceScore, rounded, when one is given', () => {
    const opportunity = { kind: 'event', title: 'AI Meetup', tags: [], location: 'Kyiv', relevanceScore: 90 };
    const heuristic = scoreOpportunity(opportunity);
    assert.equal(finalScore(opportunity), Math.round((heuristic + 90) / 2));
  });

  it('never fabricates an average from a fabricated mid-scale number -- missing means heuristic alone', () => {
    const withScore = finalScore({ kind: 'event', title: 'AI Meetup', tags: [], location: 'Kyiv', relevanceScore: 0 });
    const withoutScore = finalScore({ kind: 'event', title: 'AI Meetup', tags: [], location: 'Kyiv' });
    // relevanceScore: 0 is a real (low) opinion and must actually blend in,
    // not be treated the same as "no opinion" -- confirms `== null` (not a
    // falsy check) is what gates the fallback.
    assert.notEqual(withScore, withoutScore);
  });
});
