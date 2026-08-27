# Notion integration

There are **two separate Notion databases** in play, owned by two different
processes, summarized by two different LLMs. This is a deliberate choice,
not an accident, but it has real costs — read the tradeoffs section before
assuming "just merge them" is obviously right.

## The two databases

### 1. "Opportunities" (`NOTION_DATABASE_ID` in `.env`)

- **Pre-existing**, owned by the user, not created by this project.
- Schema: `Name` (title), `Status` (select: New / Interested - need to
  apply / Applied-Registered / Done / Skip — a personal Kanban pipeline,
  there's a board view grouped by this), `Link`, `Location`, `Funded`
  (checkbox), `Deadline`, `Type` (select: Hackathon / Summer School /
  Fellowship / Internship / Meetup / Conference), `Date found`
  (auto-created-time), and `Summary` (rich text, added by this project —
  see below).
- **Populated by**: the user manually, plus a separately-scheduled Claude
  agent (configured outside this repo, via the user's own `/schedule`
  setup) that is expected to search for new opportunities and write them
  in, and to fill `Summary` with its own one-sentence take.
- **Read by**: `src/sources/notion.js`, as one of our nine sources. `Status
  = "Skip"` rows are filtered out. **Never written to by this pipeline.**

### 2. "Opportunities Feed" (`NOTION_FEED_DATABASE_ID` in `.env`)

- **Created by this project** (see `src/lib/notion-feed.js`), specifically
  so the raw ~150-items-per-scrape auto-scraped catalogue wouldn't flood
  the user's personal, hand-curated "Opportunities" board.
- Schema: `Name`, `Link`, `Kind` (event/job), `Tags` (multi-select, options
  grow dynamically as new tags appear), `Location`, `Payment`,
  `Description` (the raw scraped text), `Company`, `Source` (which scraper
  it came from), `Deadline`, `Score` (number, our own heuristic — see
  [scoring-and-highlighting.md](./scoring-and-highlighting.md)), `External
  Id` (our sha256 `id`, for cross-referencing/dedup), `Hook` (rich text,
  reserved for the *external* scheduled Claude agent — not populated by
  anything today), `Summary` (rich text, populated by **this pipeline's own
  Gemini call**, `src/lib/summarize.js` — also not wired into the live
  pipeline yet, see [architecture.md](./architecture.md)).
- **Populated by**: `src/lib/notion-feed.js`'s `writeToFeed()`, called from
  `runPipeline()` for every genuinely new, non-`notion`-sourced
  opportunity. One-way write only — nothing reads this database back into
  the pipeline yet.

## Why two summaries, two different models

"Opportunities Feed".`Summary` is meant to be written by **Gemini**, via
this repo's `lib/summarize.js`, batched over new scraped items.
"Opportunities".`Summary` is meant to be written by **Claude**, via the
user's separately-scheduled agent, operating on a different, hand-curated
set of rows. These will not read identically — different model, different
prompt, different editorial judgment. **This is accepted as fine** (per
explicit user decision), not a bug to fix, but don't be surprised if the
two databases feel stylistically inconsistent if you ever view them side
by side.

## Why two databases: the honest tradeoff

**Good:**
- The user's personal tracker stays exactly what it was before this
  project existed — a small, curated shortlist with a Kanban workflow —
  instead of drowning in ~150 auto-scraped rows/day.
- Each database's schema fits its actual job: Feed has `Source`/`Kind`
  for filtering scraper noise; Opportunities has `Status`/`Funded` for a
  personal application-tracking workflow. Forcing one schema to do both
  jobs would compromise both.

**Bad:**
- **No de-dup between them.** If a scraped item in Feed is actually great
  and the user wants to track applying to it, they copy it into
  Opportunities by hand — there's no check to prevent the same real-world
  opportunity existing in both databases under different rows, and no
  linking field on the Opportunities side back to Feed's `External Id`.
- **Two schemas to keep in sync conceptually** (not literally — they're
  intentionally different — but anyone documenting "how summaries work"
  has to explain both, as this file does).
- **Two summarizers, two voices**, as above — a real (accepted) cost, not
  free.
- The "Opportunities" database's `Score`/`Summary`, if/when the external
  agent starts filling them, are **not readable by this pipeline** — see
  the backlog item in [PLAN.md](../PLAN.md) for the read-back module that
  doesn't exist yet.

## A note on how "Opportunities" actually gets new rows

The user's plan is for a **separately-scheduled Claude agent** (their own
`/schedule`d cloud session, entirely outside this codebase) to search the
web and add new candidate opportunities into "Opportunities." This is
**not an API call this repo makes** — there is no code here that triggers
or depends on that agent directly. It's a scheduled *prompt*, run by a
different Claude session on its own cadence, whose only visible effect on
this codebase is that `src/sources/notion.js` sees new/changed rows the
next time it reads the database. See
[assumptions-and-caveats.md](./assumptions-and-caveats.md) for why this
matters (no retry/monitoring exists in this repo for that external
process, because it *can't* — it isn't this repo's to monitor).
