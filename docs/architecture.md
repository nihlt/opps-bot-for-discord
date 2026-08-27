# Architecture

See [README.md](./README.md) first for the map and the one fact that matters
most (a lot of this repo is built but not wired into production).

## End-to-end flow, as actually wired today

```
config/sources.json (9 registered sources, 1 disabled)
        │
        ▼  src/sources/index.js: loadEnabledSources() + fetchFromSource()
┌────────────────────────────────────────────────────────────────┐
│  src/sources/*.js  (one module per source, own browser/API call) │
│  each exports fetchOpportunities(sourceConfig) -> Opportunity[]  │
│  already normalized via src/lib/normalize.js's normalizeOpportunity │
└────────────────────────────────────────────────────────────────┘
        │  src/pipeline.js: scrapeAllSources() — bounded concurrency
        │  (SCRAPE_CONCURRENCY), per-source try/catch isolation
        ▼
  applyEventPaymentPolicy() per item (src/lib/normalize.js)
  — drops paid non-fellowship courses/events, clears payment
    on free non-fellowship events, leaves jobs/kaggle untouched
        │
        ▼
  appendNewEvents() (src/lib/store.js)
  — dedupes by sha256 id against data/events.jsonl, atomic write
        │
        ├──────────────────────────────┐
        ▼                              ▼
  writeToFeed() (src/lib/notion-feed.js)   postOpportunity() per item
  — writes NEW, non-notion-sourced          (src/discord/post.js)
    opportunities to "Opportunities Feed"   — ONE embed per new opportunity,
    in Notion, each with a heuristic        posted to DISCORD_CHANNEL_ID,
    Score (src/lib/scoring.js). Summary      300ms delay between sends,
    property is NOT filled here today        capped to 15 on the very
    (see "what's not wired" below).          first run ever (empty store)
```

`src/scheduler.js` wraps `runPipeline()` in `node-cron` (`CRON_SCHEDULE`)
with an in-memory `running` boolean as an overlap guard. `src/index.js` is
the entrypoint: log into Discord, run the pipeline once immediately, then
start the cron schedule.

## What's actually wired in

(vs. what's built, tested, and demoed but not reachable from a cron run —
both kinds are listed in the table below, distinguished by the last column)

| Capability | Module | Wired into `runPipeline()`? |
|---|---|---|
| Scrape all sources | `sources/index.js`, `sources/*.js` | Yes |
| Payment policy filter | `lib/normalize.js` | Yes |
| Dedupe/store | `lib/store.js` | Yes |
| Heuristic score | `lib/scoring.js` | Yes (used by `writeToFeed`) |
| Write to Notion Feed | `lib/notion-feed.js` | Yes |
| Post one embed per item | `discord/post.js` | Yes |
| Gemini summarization | `lib/summarize.js` | **No** — never called from `pipeline.js` |
| Components V2 digest (top-3 + thread) | `discord/digest.js` | **No** — never called from `pipeline.js` |
| Percentile accent colors | `discord/score-color.js` | **No** — only reachable via `digest.js`, which isn't wired in |
| Read Score/Hook/Summary back from Notion | *(doesn't exist yet)* | No such module exists |
| Discord forum-channel source | *(doesn't exist yet)* | Backlog, see [PLAN.md](../PLAN.md) |

Everything in the "No" rows was built, unit-tested, and demonstrated by
sending real messages to the live Discord channel via one-off scripts run
manually during development — it is real, working code, just not reachable
from a cron run today.

## Module responsibilities (one line each)

- `src/index.js` — entrypoint: login, run once, start cron.
- `src/scheduler.js` — cron wrapper + overlap guard (in-memory only, see
  [resilience.md](./resilience.md)).
- `src/pipeline.js` — orchestrates one full run: scrape → filter → dedupe →
  Notion write → Discord post.
- `src/sources/index.js` — reads `config/sources.json`, dynamic-imports the
  right module per source, dispatches `fetchOpportunities(sourceConfig)`.
- `src/sources/*.js` — one per source; see [sources.md](./sources.md).
- `src/lib/normalize.js` — the `Opportunity` shape contract, id hashing,
  date parsing, keyword-based tag/location inference, the payment policy
  filter, `isFellowship()`.
- `src/lib/scoring.js` — `scoreOpportunity()`, the 0-100 heuristic. See
  [scoring-and-highlighting.md](./scoring-and-highlighting.md).
- `src/lib/store.js` — JSONL load/append with atomic write + id dedupe.
- `src/lib/notion-feed.js` — writes to the "Opportunities Feed" Notion
  database. See [notion-integration.md](./notion-integration.md).
- `src/lib/summarize.js` — Gemini-based one-sentence summarization,
  batched, JSON-mode. Not wired in yet.
- `src/discord/client.js` — logs into Discord, resolves on ready.
- `src/discord/post.js` — the live per-item embed formatter/sender.
- `src/discord/digest.js` — the prototyped top-3-plus-thread Components V2
  digest. Not wired in yet.
- `src/discord/score-color.js` — percentile-to-accent-color mapping used
  by `digest.js`.

## Opportunity shape

Every source module returns objects matching this shape (frozen by
`normalizeOpportunity()` in `src/lib/normalize.js`):

```
{
  id, sourceId, kind ('event'|'job'), title, link,
  date, dateNormalized, dateEndNormalized, datePrecision,
  location, payment, tags, description, company, calendar,
  firstSeenAt,
  // added later in the pipeline, not by normalizeOpportunity itself:
  summary   // only if lib/summarize.js's attachSummaries() was called (it isn't, in prod)
  hook      // only if a future Notion-read-back step attaches it (doesn't exist yet)
}
```
