import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentileColor } from '../src/discord/score-color.js';

describe('percentileColor', () => {
  const scores = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('returns null (no accent) for the bottom half', () => {
    assert.equal(percentileColor(10, scores), null);
    assert.equal(percentileColor(50, scores), null);
  });

  it('returns gold for the top decile', () => {
    assert.equal(percentileColor(100, scores), 0xc9a86b);
  });

  it('ramps gray between the two colors in the middle band', () => {
    const c60 = percentileColor(60, scores);
    const c70 = percentileColor(70, scores);
    const c80 = percentileColor(80, scores);
    assert.ok(c60 > 0x242429 && c60 < 0xe8e6e1);
    assert.ok(c70 > c60);
    assert.ok(c80 > c70);
    assert.notEqual(c80, 0xc9a86b);
  });

  it('is stable (no accent) when all scores are identical', () => {
    assert.equal(percentileColor(50, [50, 50, 50]), null);
  });

  it('falls back to no accent for an empty batch', () => {
    assert.equal(percentileColor(50, []), null);
  });
});
