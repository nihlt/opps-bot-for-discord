import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentileColor } from '../src/discord/score-color.js';

describe('percentileColor', () => {
  const scores = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('returns the dark color for the bottom half', () => {
    assert.equal(percentileColor(10, scores), 0x242429);
    assert.equal(percentileColor(50, scores), 0x242429);
  });

  it('returns the near-white color for the top decile', () => {
    assert.equal(percentileColor(100, scores), 0xe8e6e1);
  });

  it('ramps between the two colors in the middle band', () => {
    const c60 = percentileColor(60, scores);
    const c70 = percentileColor(70, scores);
    const c80 = percentileColor(80, scores);
    assert.ok(c60 > 0x242429 && c60 < 0xe8e6e1);
    assert.ok(c70 > c60);
    assert.ok(c80 > c70);
  });

  it('is stable when all scores are identical', () => {
    assert.equal(percentileColor(50, [50, 50, 50]), 0x242429);
  });

  it('falls back to the dark color for an empty batch', () => {
    assert.equal(percentileColor(50, []), 0x242429);
  });
});
