import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreOpportunity } from '../src/lib/scoring.js';

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
