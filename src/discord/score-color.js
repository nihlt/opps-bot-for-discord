const DARK = { r: 0x24, g: 0x24, b: 0x29 };
// Not pure white on purpose: a pure-white accent bar would vanish on
// Discord's light theme the same way a too-dark one vanishes on dark
// theme (the contrast problem we already hit once with the palette).
const LIGHT = { r: 0xe8, g: 0xe6, b: 0xe1 };

const LOW_PERCENTILE = 0.5;
const HIGH_PERCENTILE = 0.9;

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function toHex({ r, g, b }) {
  return (r << 16) | (g << 8) | b;
}

/**
 * Maps a score to a color along a dark -> near-white gradient, based on
 * its PERCENTILE RANK within `allScores` rather than its raw value --
 * the bottom half of any batch always renders as the flat dark color,
 * the top decile always reaches near-white, and the middle 40% ramps
 * between them. This stays meaningful even if the scoring rubric's
 * absolute numbers shift later, since it's always relative to the
 * batch actually being rendered.
 */
export function percentileColor(score, allScores) {
  if (!allScores.length) return toHex(DARK);

  const sorted = [...allScores].sort((a, b) => a - b);
  // A perfectly flat batch has no meaningful "top" -- default to
  // unhighlighted rather than letting everyone tie for 100th percentile.
  if (sorted[0] === sorted[sorted.length - 1]) return toHex(DARK);

  const atOrBelow = sorted.filter((s) => s <= score).length;
  const percentile = atOrBelow / sorted.length;

  if (percentile <= LOW_PERCENTILE) return toHex(DARK);
  if (percentile >= HIGH_PERCENTILE) return toHex(LIGHT);

  const t = (percentile - LOW_PERCENTILE) / (HIGH_PERCENTILE - LOW_PERCENTILE);
  return toHex({
    r: lerp(DARK.r, LIGHT.r, t),
    g: lerp(DARK.g, LIGHT.g, t),
    b: lerp(DARK.b, LIGHT.b, t),
  });
}
