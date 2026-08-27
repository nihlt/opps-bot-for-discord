import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatOpportunityEmbed } from '../src/discord/post.js';

function opp(overrides = {}) {
  return { title: 'AI Meetup', kind: 'event', tags: [], location: 'Online', link: 'https://x.test', ...overrides };
}

describe('formatOpportunityEmbed', () => {
  it('uses the summary as the embed description when present', () => {
    const embed = formatOpportunityEmbed(opp({ summary: 'Concrete benefit sentence.', description: 'Raw promo filler.' }));
    const json = embed.toJSON();
    assert.equal(json.description, 'Concrete benefit sentence.');
  });

  it('omits the description entirely when there is no summary, even with a raw description present', () => {
    const embed = formatOpportunityEmbed(opp({ description: 'Raw promo filler nobody should see.' }));
    const json = embed.toJSON();
    assert.equal(json.description, undefined);
  });
});
