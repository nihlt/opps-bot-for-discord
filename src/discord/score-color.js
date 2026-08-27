const DARK = { r: 0x24, g: 0x24, b: 0x29 };
// Not pure white on purpose: a pure-white accent bar would vanish on
// Discord's light theme the same way a too-dark one vanishes on dark
// theme (the contrast problem we already hit once with the palette).
const LIGHT = { r: 0xe8, g: 0xe6, b: 0xe1 };
const GOLD = 0xc9a86b;

const MID_PERCENTILE = 0.5;
const TOP_PERCENTILE = 0.9;

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function toHex({ r, g, b }) {
  return (r << 16) | (g << 8) | b;
}

/**
 * Maps a score to an accent color based on its PERCENTILE RANK within
 * `allScores` (not its raw value), so this stays meaningful even if the
 * scoring rubric's absolute numbers shift later:
 *   - bottom 50%: null -- no accent color at all, renders as a plain
 *     container.
 *   - top 10%: a flat muted gold (#C9A86B) -- these are the picks.
 *   - the middle 40%: a gray ramp from dark (#242429) to near-white
 *     (#E8E6E1), same as before.
 */
export function percentileColor(score, allScores) {
  if (!allScores.length) return null;

  const sorted = [...allScores].sort((a, b) => a - b);
  // A perfectly flat batch has no meaningful "top" -- default to
  // unhighlighted rather than letting everyone tie for 100th percentile.
  if (sorted[0] === sorted[sorted.length - 1]) return null;

  const atOrBelow = sorted.filter((s) => s <= score).length;
  const percentile = atOrBelow / sorted.length;

  if (percentile <= MID_PERCENTILE) return null;
  if (percentile >= TOP_PERCENTILE) return GOLD;

  const t = (percentile - MID_PERCENTILE) / (TOP_PERCENTILE - MID_PERCENTILE);
  return toHex({
    r: lerp(DARK.r, LIGHT.r, t),
    g: lerp(DARK.g, LIGHT.g, t),
    b: lerp(DARK.b, LIGHT.b, t),
  });
}
