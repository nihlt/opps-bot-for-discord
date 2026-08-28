# Scoring and highlighting

Three separate, deliberately decoupled mechanisms:

1. **`scoreOpportunity()`** (`src/lib/scoring.js`) — a deterministic 0-100
   heuristic, no LLM involved. Computed for every opportunity, always, with
   no dependency on a batch or population.
2. **The LLM relevance veto + `relevanceScore`** (`src/lib/summarize.js`) —
   a semantic judgment call the regex heuristic above structurally can't
   make. See "LLM relevance veto and `finalScore()`" below.
3. **`percentileColor()` / `percentileOf()`** (`src/discord/score-color.js`)
   — maps a score to an accent color, but only *relative to a population
   of scores you pass in*. This is population-dependent by design; see
   "the scoringPopulation trap" below. (`percentileOf()` used to also
   drive a visible "better than 0.NN" text label — removed, see below.)

Everything that actually ranks/displays an item (`digest.js`'s sort order
and accent color, `notion-feed.js`'s `Score` property) uses `finalScore()`,
not `scoreOpportunity()` directly — see below.

## The scoring rubric

Target audience, stated explicitly because it drives every weight below:
**1st-4th year Computer Science / AI Systems undergrads at Lviv Polytechnic
(LPNU)**. The score approximates a result-for-effort ratio for *that*
audience specifically, not a general "how good is this opportunity" score.

- **Base, by category** (mutually exclusive, checked in this order):
  fellowship/stipend (`isFellowship()`, checks title+tags only — see below)
  → 65. Internship tag → 55. Hackathon/competition (`isHackathon()`, by a
  hackathon-specific `sourceId` — `dou-hackathon`/`kaggle` only — or a
  title keyword match, tags deliberately not consulted — see below —
  lives in `lib/normalize.js`, imported here, and reused by
  `discord/digest.js`'s category grouping and by the payment-policy
  filter, see [discord-integration.md](./discord-integration.md), so none
  of the three can quietly disagree about what counts as a hackathon)
  → 55 (bumped from an initial 45 per feedback — "hackathons and
  competitions deserve the same tier as internships"). Generic event → 25.
  `kind: 'job'` is scored on a *different* axis entirely: base 30, plus a
  4-step experience curve (`yearsOfExperienceBonus()`: ≤0.5y → +15, <1.5y
  → +8, <2y → +0, ≥2y → −15 — smoothed from a flat 3-way split because
  djinni jobs cluster heavily around "1 рік" and used to all tie there),
  plus a required-English-level bonus (`englishLevelBonus()`, parsed from
  the same djinni field: None/A1/A2 → +10, B1 → +5, B2 → 0, C1/C2 → −10 —
  lower bar is more accessible for the target audience, and it's the one
  axis that actually varies across otherwise-identical junior postings).
- **Location bonus** (the biggest single lever, **events only**): Lviv
  mention → +25 (the department's home city, zero travel cost).
  Online/remote mention → +10. Anywhere else → +0. **For jobs, this skips
  the description entirely** — a job's `location` field isn't a place
  (djinni packs work-format/experience/English/industry into it instead,
  see [discord-integration.md](./discord-integration.md#category-assignment-categorizeopportunity-priority-order)
  for the same fact affecting category assignment), and scanning a job ad's
  free-text description for "Lviv" is a coin flip most on-site postings
  never confirm — better to score it as unknown than sometimes-right.
- **Audience-fit bonus**: AI/ML/NLP keyword match anywhere in title/
  description/tags → +5.
- Clamped to [0, 100].

### Job scores used to collide constantly — fixed by adding real signal, not by faking one

Live example that surfaced this: three djinni AI jobs — two "Тільки
віддалено, 0.5 років досвіду" postings differing only in required English
(A1 vs B1), and a third, "Тільки офіс, 1 рік досвіду" — all showed
**score 60**. The first two tied because English wasn't scored at all yet;
the third only matched by accident, because its scraped description
happened to mention "Lviv office" and picked up the (event-oriented) Lviv
bonus through free-text scanning. Fixed two ways: added the English-level
bonus above (real per-audience signal, not decoration) and stopped
scanning job descriptions for Lviv (see above) so a job's score no longer
depends on whether its ad copy happens to name a city. Remaining ties
(e.g. several "1 рік, офіс, no English requirement" postings) are now
*honest* ties — they really do share every scored attribute — rather than
coincidental ones.

When a score still ties, ordering isn't left to incidental array order:
`discord/digest.js`'s `sortByScoreDesc()` breaks ties by earliest
`firstSeenAt` first, then title, so equal-score items land in a
deliberate, explainable order. This tie-break only became meaningful for
most sources once `lib/store.js`'s `appendNewEvents()` started stamping
`firstSeenAt` on every newly-persisted item — before that fix, only the
`notion` source ever had a real value there, so the tie-break silently
fell through to title-only ordering for everything else.

### `isFellowship()` only checks title + tags, not description

A real bug, fixed once: it originally scanned the full description too, and
a defense-tech *conference* whose description happened to mention "гранти"
(grants) as a discussion topic got misclassified as a fellowship — which
both exempted it from the payment-policy filter and inflated its score.
Fellowships name themselves as such in the title; scanning free-text
descriptions for a stray keyword is too loose. If you're tempted to widen
this back to the description, don't, unless you also add a stronger
qualifier than a bare "grant"/"грант" substring match.

### `isHackathon()` only checks title + dedicated sourceIds, not tags or `dou-competition`

A second real bug in the same family as `isFellowship()`'s above, found
live: a Lviv charity run (OBRIO × Chumaky, `sourceId: dou-competition`)
showed up in the digest as a **Hackathon**, with an inflated score, *and*
a false `· $` marker. Root cause was `hackathonSources` blanket-trusting
`dou-competition` and `hackathonTagPattern` scanning `tags` as well as
title: DOU's "змагання" (competitions) calendar tags **any** competitive
event — sports races included, not just coding ones — and
`src/sources/dou-calendar.js` mechanically injects that tag onto every
item it scrapes from that page, regardless of what the event actually
is. The charity run's own "participate for a 500 грн donation" line then
survived `applyEventPaymentPolicy()` (which had just been made to exempt
`isHackathon()` items, see below) and got read by `hasMoneyPrize()` as
prize money.

Fixed by narrowing `isHackathon()` to: `dou-hackathon`/`kaggle` by
sourceId (calendars/platforms that really are hackathon-specific) OR the
item's own **title** matching the keyword pattern — tags are no longer
consulted at all, and `dou-competition` is no longer a trusted sourceId.
Same lesson as `isFellowship()`: a mechanically-attached label (whether a
tag or a source's own categorization) is not the same as the event
describing itself as a hackathon. The cost is a few genuine
`dou-competition` coding competitions now falling through to the generic
"Events" tier if their title doesn't say "hackathon"/"змагання"/
"competition" — accepted, since a false "this is a hackathon that pays
prize money" is worse than an occasional missed real one.

This same charity run is also the motivating example for the LLM relevance
veto below: even with the miscategorization fixed, it still passes every
keyword filter as a generic "Event" and picks up the Lviv location bonus —
regex has no way to know a charity run isn't something a CS/AI student
audience cares about. That's exactly the gap the LLM veto closes; it's used
verbatim as the in-prompt negative example (see below).

### LLM relevance veto and `finalScore()`

Regex/keyword rules (`isFellowship()`, `isHackathon()`, the location/AI-fit
bonuses above) can only match surface patterns — they can't tell that
"Charity Run у Львові OBRIO × Chumaky × Молодвіж" is a sports event just
because a tech company sponsors it. `src/lib/summarize.js`'s single
batched Vertex AI call (the same one that writes the digest's one-sentence
summary) also asks the model to judge each new item against an explicit
rubric for the same audience (1st-4th year CS/AI Systems LPNU undergrads):

- **Relevant**: hackathons/coding & ML competitions; fellowships/grants/
  scholarships; tech jobs/internships/trainee programs; tech conferences/
  workshops/courses on programming/AI/ML/data; CS/STEM research or
  exchange programs.
- **Not relevant**, even if a tech company organizes or sponsors it:
  generic sports events, charity runs, cultural/social/community events,
  generic business/entrepreneurship events with no CS angle, events for an
  unrelated professional field.
- **Decision rule given verbatim to the model**: does the event's own
  *activity* (not who organizes or sponsors it) build a technical skill, a
  resume line, or a career opportunity specifically valuable to a CS/AI
  student? If the only tech connection is the sponsor/organizer's identity
  and the activity itself isn't technical or CS-career-relevant, it's not
  relevant.
- The actual charity-run title above is given to the model as an in-prompt
  few-shot negative example, paired with a clearly-relevant contrast
  example — a concrete anchor beats an abstract rule.

The model returns `relevant` (boolean) and, only when `relevant: true`, a
`relevanceScore` (0-100, same anchors philosophy as `scoreOpportunity()`:
90-100 flagship/highly specific fit, 60-89 clearly relevant but not
top-tier, 30-59 tangentially relevant).

**The veto is absolute and happens before ranking, not as part of it**:
`src/pipeline.js` filters `newEvents` down to `relevant !== false` right
after persisting (see below for why persistence itself is unconditional)
and *before* either `writeToFeed()` or `postDigest()` ever see the list —
no heuristic score, however high, can override an LLM veto. `finalScore()`
(`src/lib/scoring.js`) is only ever computed for items that already
survived that filter:

```js
export function finalScore(opportunity) {
  const heuristic = scoreOpportunity(opportunity);
  if (opportunity.relevanceScore == null) return heuristic;
  return Math.round((heuristic + opportunity.relevanceScore) / 2);
}
```

A straight 50/50 average with the heuristic score, not an LLM-only score —
`scoreOpportunity()` stays the authoritative, deterministic, independently
tested ranking signal; the LLM only adds a second opinion on top of it, and
only for the subset of ranking-relevant nuance a keyword match can't see
(e.g. how strong an AI hackathon's actual fit is, not just that it matched
`aiFitPattern`). `digest.js`'s sort order/accent color and
`notion-feed.js`'s `Score` property both call `finalScore()`, never
`scoreOpportunity()` directly, any more.

**Fail-open, deliberately, at both layers**: `relevanceScore == null` (an
LLM outage, a per-item response that omitted it, or an item that was never
even sent to the LLM) makes `finalScore()` fall back to the heuristic alone
— never a fabricated mid-scale number. And `attachSummaries()` itself
defaults every field to the safest "don't suppress anything" values
(`relevant: true`, `relevanceScore: null`) on a total call failure, the same
philosophy as `.summary = null` on failure: an AI outage must degrade
gracefully, never silently hide a real opportunity.

**Persistence is unconditional, independent of the veto**: every new item —
vetoed or not — still gets written to `data/events.jsonl` via the normal
`appendNewEvents()` call, *before* the veto filter is even applied. This is
the actual efficiency point of doing relevance judgment in the summarize
call at all: a vetoed item is dedup-recognized and never re-scraped/re-sent
to the LLM on a later run, so the one-time judgment cost is paid exactly
once per item, ever — not once per day for as long as the source keeps
listing it. The veto only gates the *display* boundary (`writeToFeed()`,
`postDigest()`, and `src/replay-digest.js`'s manual replay tool, which
applies the identical `relevant !== false` filter since it bypasses
`pipeline.js` entirely), never the store write.

### The `Payable` checkbox / the `· $` marker

`hasMoneyPrize()` (`src/lib/normalize.js`, alongside `isFellowship()` and
`isHackathon()` — moved there specifically so this function and
`applyEventPaymentPolicy()` could share one definition of "is this a
hackathon" without a circular import with `lib/scoring.js`) answers a
narrower question than "is this a fellowship/hackathon": **does it state
an actual money figure**. True only when both hold:
1. It's a fellowship (`isFellowship()`) or hackathon/competition
   (`isHackathon()`) — never a job (a salary isn't "winning money" in the
   same sense, and scoring already treats jobs on a separate axis).
2. Its `payment` or `description` text matches the same
   `currencyAmountPattern` used by the payment-policy filter — a bare
   "funded" or "generous stipend" does **not** qualify; there has to be an
   actual `$`/`₴`/`€`/number.

This is deliberately conservative — the point is a reliable "this one
pays" signal, not an optimistic guess. It drives two things: the `· $`
suffix on the item's title in `discord/digest.js`, and the `Payable`
checkbox column written by `lib/notion-feed.js` into "Opportunities Feed"
(see [notion-integration.md](./notion-integration.md) — that property
has to actually exist in the live database's schema, added by hand if the
Notion MCP connector isn't available).

**This surfaced and fixed a real, previously-invisible bug in the payment
filter**: `applyEventPaymentPolicy()` used to clear the `payment` field
for *any* non-fellowship event — including hackathons, even though a
hackathon's `payment` field (e.g. scraped from dou.ua's own "when and
where" block) is exactly as legitimate a "money paid to you" signal as a
fellowship's. Before this feature, that bug had zero visible effect
(nothing ever displayed `payment` in the digest), so it went unnoticed
until `hasMoneyPrize()` needed a hackathon's real prize field to still be
there. Fixed by exempting `isHackathon()` from that filter the same way
`isFellowship()` already was.

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

`digest.js` used to also print a "better than 0.NN" (or, at the top
decile, "one of the best") text label per item, using this same
`percentileOf()` number. **Removed** — after the same live example that
motivated the English-level fix below, seeing the raw score/percentile
repeated identically across visibly different jobs read as noise, not
useful signal, so the number itself is gone from the visible text
entirely. `percentileOf()`/`percentileColor()` still drive everything
else (accent color, sort order, which 3 items make a category's main
message) — only the printed number went away.

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

`lib/notion-feed.js` writes `finalScore()`'s result (see above — the
heuristic blended with the LLM's `relevanceScore` when it gave one) into
every row's `Score` property in "Opportunities Feed." The user's
separately-scheduled
Claude agent (outside this codebase) is expected to independently evaluate
and potentially overwrite `Score` on the "Opportunities" database (a
*different* database — see [notion-integration.md](./notion-integration.md))
using its own judgment/criteria, not this heuristic. There is currently no
code path that reads that agent's Score back into this pipeline.
