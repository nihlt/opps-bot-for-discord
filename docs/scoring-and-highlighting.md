# Scoring and highlighting

Two separate, deliberately decoupled mechanisms:

1. **`scoreOpportunity()`** (`src/lib/scoring.js`) — a deterministic 0-100
   heuristic, no LLM involved. Computed for every opportunity, always, with
   no dependency on a batch or population.
2. **`percentileColor()` / `percentileOf()`** (`src/discord/score-color.js`)
   — maps a score to an accent color / a "better than X%" figure, but only
   *relative to a population of scores you pass in*. This is population-
   dependent by design; see "the scoringPopulation trap" below.

## The scoring rubric

Target audience, stated explicitly because it drives every weight below:
**1st-4th year Computer Science / AI Systems undergrads at Lviv Polytechnic
(LPNU)**. The score approximates a result-for-effort ratio for *that*
audience specifically, not a general "how good is this opportunity" score.

- **Base, by category** (mutually exclusive, checked in this order):
  fellowship/stipend (`isFellowship()`, checks title+tags only — see below)
  → 65. Internship tag → 55. Hackathon/competition (`isHackathon()`, by
  `sourceId` or a title/tag keyword match — also exported and reused by
  `discord/digest.js`'s category grouping, see
  [discord-integration.md](./discord-integration.md), so the score bump
  and the "Hackathons" bucket can never quietly disagree with each other)
  → 55 (bumped from an initial 45 per feedback — "hackathons and
  competitions deserve the same tier as internships"). Generic event → 25.
  `kind: 'job'` is scored on a *different* axis
  entirely: base 30, +15 if the (djinni/work-ua) location string implies
  ≤0.5 years of experience required, -15 if it implies ≥2 years — a rough
  proxy for "can a 1st-4th-year actually get this."
- **Location bonus** (the biggest single lever): Lviv mention → +25 (the
  department's home city, zero travel cost). Online/remote mention → +10.
  Anywhere else → +0.
- **Audience-fit bonus**: AI/ML/NLP keyword match anywhere in title/
  description/tags → +5.
- Clamped to [0, 100].

### `isFellowship()` only checks title + tags, not description

A real bug, fixed once: it originally scanned the full description too, and
a defense-tech *conference* whose description happened to mention "гранти"
(grants) as a discussion topic got misclassified as a fellowship — which
both exempted it from the payment-policy filter and inflated its score.
Fellowships name themselves as such in the title; scanning free-text
descriptions for a stray keyword is too loose. If you're tempted to widen
this back to the description, don't, unless you also add a stronger
qualifier than a bare "grant"/"грант" substring match.

### Calibration is a one-time snapshot, not a live target

The weights above were hand-tuned by running them against the **first real
scrape** (167 items, 145 after the payment filter) until roughly the top
10% cleared a score around 65-70+. There is no code that re-checks this
distribution as the catalogue's composition drifts over time — if the
scrapers start returning proportionally more/fewer fellowships, hackathons,
etc., "top 10%" could silently become "top 3%" or "top 25%" of what's
actually posted, with nothing flagging the drift. Also: nothing filters
*expired* opportunities (past `dateNormalized`) out of the scoring
population, so old events accumulate in `data/events.jsonl` and dilute any
percentile computed against "the whole stored catalogue" forever, unless
something is added to exclude them.

## Percentile-based accent color

`percentileOf(score, allScores)` returns what fraction of `allScores` this
score is at-or-above. `percentileColor()` bands that into:

- **Bottom 50%**: `null` — no accent color, plain container.
- **Middle 40% (50-90th percentile)**: a gray ramp from `#242429` (dark) to
  `#E8E6E1` (near-white, *not* pure white — pure white would vanish on
  Discord's light theme the same way a too-dark accent vanishes on dark
  theme; this was an actual back-and-forth during design).
- **Top 10%**: a flat muted gold, `#C9A86B`.

`digest.js`'s per-item "better than 0.NN" label uses the same
`percentileOf()` number, but swaps to the fixed phrase **"one of the best"**
for percentile ≥ 0.9 — a bare "better than 1.00" for the top item in a
batch is mathematically correct but reads as a bug.

### The `scoringPopulation` trap

`postDigest(channel, opportunities, { scoringPopulation })` takes a
*separate* population to rank against, defaulting to `opportunities` itself
only if nothing broader is supplied. **This default is almost never what
you want in production.** Ranking a tiny daily batch (maybe 2-5 new items)
against itself is close to meaningless — a single mediocre item can look
"top 10%" purely because nothing else was in that run. Always pass the full
known catalogue (e.g. everything in `data/events.jsonl`) as
`scoringPopulation` when calling this for real. This was a real bug caught
during live demoing, not a hypothetical — see git history around "Fix
percentile scope."

## Not the same as the Notion `Score` property

`lib/notion-feed.js` writes `scoreOpportunity()`'s result into every row's
`Score` property in "Opportunities Feed." The user's separately-scheduled
Claude agent (outside this codebase) is expected to independently evaluate
and potentially overwrite `Score` on the "Opportunities" database (a
*different* database — see [notion-integration.md](./notion-integration.md))
using its own judgment/criteria, not this heuristic. There is currently no
code path that reads that agent's Score back into this pipeline.
