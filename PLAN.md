# Discord Opportunities Bot — Implementation Plan

Companion to the architecture decisions already made (see chat history / commit
messages). This file breaks the build into stages with concrete test
checkpoints, and marks which parts are safe to run in parallel (multiple
agents/sessions) vs. must be sequential.

**For how the system actually works today (what's wired in vs. built-but-
dormant, the two Notion databases, failure modes, known caveats), see
[docs/README.md](./docs/README.md)** — this file stays focused on
forward-looking stages/backlog, not on documenting existing behavior.

Secrets already validated live (2026-08-27): `DISCORD_BOT_TOKEN`,
`DISCORD_CHANNEL_ID` (`#general`), `NOTION_TOKEN`, `NOTION_DATABASE_ID` all
confirmed working against the real Discord/Notion APIs.

## Dependency graph

```
Stage 0 (scaffolding)
    │
    ├── must finish before anything else starts
    ▼
Stage 1 — PARALLEL tracks (no shared files between tracks)
    ├── 1A  lib/store.js
    ├── 1B  discord/client.js + discord/post.js
    ├── 1C  sources/notion.js
    ├── 1D  sources/dou-calendar.js
    ├── 1E  sources/ain-opportunities.js
    ├── 1F  sources/kaggle-competitions.js
    ├── 1G  sources/kse-news.js
    ├── 1H  sources/djinni.js
    ├── 1I  sources/work-ua.js
    └── 1J  sources/robota-ua.js (ported but left disabled)
    │
    ▼ (all of Stage 1 merged)
Stage 2 (integration — sequential, one agent)
    │
    ▼
Stage 3 (optional /refresh command — sequential, small)
    │
    ▼
Stage 4 (soak test / verification)
```

**Stage 1 can run with up to ~9 agents in parallel** — each track owns files no
other track touches, so there's no merge conflict even without git worktrees,
*as long as Stage 0 has already fixed*: the `Opportunity` object shape
(`lib/normalize.js`), the full dependency list in `package.json`, and a
skeleton `config/sources.json` with every source's entry pre-declared (so no
two Stage-1 agents need to edit that same file). If you want extra safety
(e.g. an agent's Playwright experimentation leaving stray processes/files),
run each Stage-1 track in its own git worktree — not required, just
belt-and-suspenders.

Realistically: you don't need 9 agents. A good split is **4 agents**:
- Agent 1: 1A + 1B (store + discord delivery — small, related)
- Agent 2: 1C + 1D + 1E (notion + dou-calendar + ain — content-style sources)
- Agent 3: 1F + 1G (kaggle + kse-news)
- Agent 4: 1H + 1I + 1J (djinni + work-ua + robota-ua — job sources, similar shape)

---

## Stage 0 — Scaffolding (sequential, ~1 agent, do this first)

- [ ] `package.json` with full dependency list: `discord.js`, `playwright`,
      `node-cron`, `@notionhq/client`, `dotenv`. Add `"type": "module"`.
- [ ] `npm install` + `npx playwright install chromium`
- [ ] `.gitignore` (`node_modules/`, `.env`, `data/events.jsonl`, `data/*.log`)
- [ ] `.env.example` (mirrors the real `.env` keys, no values)
- [ ] Folder skeleton: `src/{discord,sources,lib}/`, `config/`, `data/`, `tests/`
- [ ] `config/sources.json` — full registry, every source pre-declared
      (id, module path, kind, enabled), even before each scraper file exists:
      ```json
      [
        {"id": "notion", "module": "notion.js", "kind": "event", "enabled": true},
        {"id": "dou-ai", "module": "dou-calendar.js", "kind": "event", "enabled": true, "tag": "AI"},
        {"id": "dou-hackathon", "module": "dou-calendar.js", "kind": "event", "enabled": true, "tag": "хакатон"},
        {"id": "dou-competition", "module": "dou-calendar.js", "kind": "event", "enabled": true, "tag": "змагання"},
        {"id": "ain", "module": "ain-opportunities.js", "kind": "event", "enabled": true},
        {"id": "kaggle", "module": "kaggle-competitions.js", "kind": "event", "enabled": true},
        {"id": "kse-news", "module": "kse-news.js", "kind": "event", "enabled": true},
        {"id": "djinni", "module": "djinni.js", "kind": "job", "enabled": true},
        {"id": "work-ua", "module": "work-ua.js", "kind": "job", "enabled": true},
        {"id": "robota-ua", "module": "robota-ua.js", "kind": "job", "enabled": false, "disabledReason": "Cloudflare blocks headless access"}
      ]
      ```
- [ ] `src/lib/normalize.js` — defines and exports the shared `Opportunity`
      shape (see architecture doc), `makeId(sourceId, link)` (sha256 hash),
      date parsing helpers, tag mapping. **This is the contract every Stage-1
      track codes against — freeze its exported function signatures before
      moving on.**
- [ ] `tests/normalize.test.mjs` — id hash is stable for the same input,
      differs for different input; date parser handles a few known formats.

**Test checkpoint (blocks Stage 1 start):** `npm test` green for
`normalize.test.mjs`; `node -e "import('./src/lib/normalize.js').then(m=>console.log(Object.keys(m)))"`
prints the expected exports.

---

## Stage 1 — Parallel tracks

Each track's checkpoint must pass before its output is wired into Stage 2.
None of these need each other — verify independently.

### 1A — `src/lib/store.js`
Read/append `data/events.jsonl`, atomic write (temp file + rename), dedupe by
`id`.
**Test:** `tests/store.test.mjs` — append 3 fake events to a temp JSONL file,
re-open and confirm dedupe (re-appending the same id is a no-op), confirm
atomic write leaves no `.tmp` file behind after success. No network.

### 1B — `src/discord/client.js` + `src/discord/post.js`
Login with `DISCORD_BOT_TOKEN`, format one `Opportunity` as an embed, send to
`DISCORD_CHANNEL_ID`.
**Test:** small standalone script that logs in and sends one hardcoded fake
`Opportunity` embed to the real `#general` channel, confirm it renders
correctly (title/link/date/location/tags), then manually delete it. (We
already proved raw send/delete works via curl — this test proves the
discord.js wrapper + embed formatting works too.)

### 1C — `src/sources/notion.js`
Query the `Opportunities` data source via `@notionhq/client`, map fields per
the architecture doc (`Name→title, Type→tags, Deadline→dateNormalized/
dateEndNormalized, Location→location, Funded→payment, Link→link`), skip
`Status = "Skip"` rows, use `Date found` as `firstSeenAt`.
**Test:** run standalone against the real Notion DB, confirm returned objects
match the `Opportunity` shape, confirm the one `Status=Skip` row (if any
exists yet) is excluded — spot-check against the raw Notion query result we
already pulled (e.g. the "Pie & AI: Kyiv" row, `Status: New`, should appear).

### 1D — `src/sources/dou-calendar.js`
Port from `opps-monitor/scrapers/dou-calendar.mjs`. Handles all 3
`sources.json` entries (`dou-ai`, `dou-hackathon`, `dou-competition`) via a
`tag` param.
**Test:** run standalone for each of the 3 tag configs against the live site,
confirm non-empty results, spot-check 2-3 items' title/link/date after
`normalize.js` processing.

### 1E — `src/sources/ain-opportunities.js`
Port from `opps-monitor/scrapers/ain-opportunities.mjs`.
**Test:** same pattern — live run, non-empty, spot-check normalized output.

### 1F — `src/sources/kaggle-competitions.js`
Port from `opps-monitor/scrapers/kaggle-competitions.mjs`.
**Test:** live run, non-empty, spot-check.

### 1G — `src/sources/kse-news.js`
Port from `opps-monitor/scrapers/kse-news.mjs`.
**Test:** live run, non-empty, spot-check.

### 1H — `src/sources/djinni.js`
Port from `opps-monitor/scrapers/djinni.mjs`, including the good/bad keyword
title classifier (`data/job-keywords.json`, copy over).
**Test:** live run, non-empty, confirm `kind: "job"` + `company` field
populated, confirm keyword classifier drops obviously irrelevant titles.

### 1I — `src/sources/work-ua.js`
Port from `opps-monitor/scrapers/work-ua.mjs`.
**Test:** live run, non-empty, `kind: "job"` populated.

### 1J — `src/sources/robota-ua.js`
Port from `opps-monitor/scrapers/robota-ua.mjs`, **keep `enabled: false`** in
`sources.json` (Cloudflare blocks headless scraping — known, unsolved).
**Test:** just confirm the module loads and exports the right shape; no live
run expected to succeed, that's fine — it stays disabled either way.

---

## Stage 2 — Integration (sequential, one agent, after Stage 1 merges)

- [ ] `src/sources/index.js` — loads `config/sources.json`, dispatches to the
      right module per entry.
- [ ] `src/pipeline.js` — `runPipeline()`: bounded-concurrency scrape
      (`SCRAPE_CONCURRENCY`, isolate per-source failures) → normalize → dedupe
      via `store.js` → post new ones via `discord/post.js`.
- [ ] `src/scheduler.js` — `node-cron` wrapper around `runPipeline()`
      (`CRON_SCHEDULE`), in-memory overlap guard.
- [ ] `src/index.js` — entrypoint: Discord client login → on `ready`, run
      pipeline once immediately, then start the cron schedule.
- [ ] First-run cap: if `data/events.jsonl` doesn't exist yet, cap the first
      post-batch to the newest N items instead of dumping the entire
      catalogue into the channel at once (port this idea from
      `opps-monitor/scripts/run-daily-pipeline.mjs`).

**Test checkpoint:** `npm start` locally with the real `.env`. Confirm:
1. Bot goes **online** in Discord (status dot changes from offline to online).
2. First run posts a bounded batch of real opportunities into `#general`.
3. Stop and re-run `npm start` — confirms nothing gets reposted (dedupe
   works across process restarts, not just in-memory).
4. `data/events.jsonl` contains one line per posted item, valid JSON each.

---

## Stage 3 — `/refresh` slash command (optional, sequential, small)

- [ ] `src/discord/commands.js` — register `/refresh`, restricted to an admin
      user/role ID from `.env`, triggers `runPipeline()` on demand.
**Test:** invoke `/refresh` in Discord as the admin user, confirm it runs and
posts only genuinely new items; invoke as a non-admin user (if testable),
confirm it's rejected.

---

## Stage 4 — Soak test / final verification

- [ ] Let one real cron cycle fire un-touched (or temporarily set
      `CRON_SCHEDULE` to a couple minutes out) — confirm the scheduled run
      behaves identically to the manual first run, confirm the overlap guard
      would reject a second trigger fired mid-run.
- [ ] `npm test` full suite green.
- [ ] Review `data/events.jsonl` growth is sane (no duplicate ids, no
      malformed lines).

---

## Backlog — deferred, mechanical work

### New source: Discord forum channel
Add scraping for `https://discord.com/channels/1029547539424366632/1215783932252127283`
(guild `1029547539424366632`, channel `1215783932252127283`) — looks like a
Discord **Forum Channel**: each post is a tagged thread (e.g. "Interface
Alignment Interventions" tagged `education` + `event`); opening a post shows
a detailed description + registration links in the thread's first message.

**Decision already made:** use the official **Discord Bot API**
(`discord.js`, already a dependency) — `channel.threads.fetch()` for the
thread list, `thread.appliedTags` for tags, first message of each thread for
the description/links. Map into our `Opportunity` shape same as any other
`src/sources/*.js` module.

**Explicitly ruled out:** automating the user's personal Discord account
(browser cookies + headless, or a raw user token) to read the channel via
the web client. Both are "self-bot" style automation of a human account,
which violates Discord's ToS regardless of implementation mechanism, and
risks the account getting banned. Not doing this even for read-only scraping.

**Blocker before implementing:** our bot must be invited into guild
`1029547539424366632` with permission to view that channel — needs someone
with "Manage Server" there to add it. Also confirm the "Message Content
Intent" is enabled for the bot in the Discord Developer Portal (needed to
read thread message text via the API, on top of the `GatewayIntentBits`
already requested in `src/discord/client.js`).

### Read Score + Hook back from Notion Feed into the digest
Notion "Opportunities Feed" (`collection://c1d8983c-256d-4c08-84db-6bc362264be2`)
now has a `Hook` property (rich text, added alongside `Score`) for the
user's separately-scheduled Claude agent to fill in: a one-sentence
concrete-benefit blurb per opportunity, replacing the raw scraped
description (which is usually promotional filler from the source site, not
what the reader actually gets out of it). `src/discord/digest.js` already
prefers `opportunity.hook` over the sentence-truncated description when
present -- but nothing populates `.hook` yet.

**Needs, once that agent is actually producing Score/Hook data:**
- A new read module (e.g. `src/lib/notion-feed-reader.js`) that queries the
  Feed database via `@notionhq/client` and returns Score/Hook keyed by
  `External Id` (the sha256 `id` we already write on every row).
- `pipeline.js` (or wherever `postDigest` ends up being called) merges that
  back onto each `Opportunity` before building the digest -- our own
  heuristic `scoreOpportunity()` should probably stay as a same-day
  fallback for anything the external agent hasn't scored yet, since it
  runs on its own schedule and won't have processed brand-new rows
  immediately.
- Also still pending: `postDigest` is built and tested but not yet wired
  into `pipeline.js`'s actual posting step (which still posts one embed per
  new opportunity via `discord/post.js`). Decide whether to replace that
  entirely or keep both.
