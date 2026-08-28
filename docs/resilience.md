# Resilience — what actually happens when things break

Honest answers, traced to actual code, not aspirational descriptions. Where
the answer is "nothing good happens," that's stated plainly — see
[assumptions-and-caveats.md](./assumptions-and-caveats.md) for the list of
gaps this implies.

## The Vertex AI (Gemini) API doesn't respond, times out, or errors

`src/lib/summarize.js`'s `attachSummaries()` wraps the whole call —
resolving an OAuth2 access token via `google-auth-library`/ADC, *and* the
single batched `generateContent` request — in try/catch. Any failure —
ADC/credentials error, network error, non-2xx HTTP status, missing
candidate text, unparseable JSON, JSON that isn't an array — is caught,
logged (`console.error`), and **every opportunity in that batch gets
`.summary = null`**. Nothing throws further up into `pipeline.js`.

Consequences: `scoreOpportunity()` is unaffected (pure function, no LLM
dependency) — ranking and gold/gray highlighting keep working normally.
`discord/digest.js` shows no description line for affected items rather
than falling back to raw scraped text — this is by design, not a gap.
`notion-feed.js`'s `Summary` property is simply omitted from the write
(not set to a placeholder).

**What's NOT handled**: no retry, no backoff, single attempt per pipeline
run. It's an all-or-nothing batch — if the Vertex AI call fails, *every*
item in that run loses its summary, not just a problematic one, because
they're all sent in one call. **What is now handled**: `attachSummaries()`
takes an `onFailure(error)` callback; `pipeline.js` uses it to push a line
into that run's `issues` and DM every `ADMIN_DISCORD_USER_IDS` admin once
at the end (see [discord-integration.md](./discord-integration.md) and
`src/discord/alerts.js`) — so a revoked service account key or an invalid
`GEMINI_MODEL`/`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` combination
no longer degrades silently run after run with only a console line to
show it; someone gets a DM the same run it first breaks.

## The LLM returns invalid JSON (or valid JSON, wrong shape)

`summarizeOpportunities()` strips a stray ` ```json ` fence defensively
(models sometimes add one despite being told not to), then `JSON.parse()`s
the result. A parse failure, or a value that parses but isn't an array,
both throw — caught by `attachSummaries()` exactly as any other failure
above (blank summaries, no crash). No repair attempt (e.g. re-prompting the
model with the parse error) exists — one shot, then give up cleanly for
that run.

## The "web search" (the user's separately-scheduled Claude agent) doesn't run, or comes back empty

This is **not this repo's code** — it's a scheduled prompt in a different
Claude session, entirely outside this codebase's control or visibility
(see [notion-integration.md](./notion-integration.md)). If it stops
running, or runs but finds nothing, the only visible effect here is that
`src/sources/notion.js` reads whatever is already in the "Opportunities"
database — no new rows, no error, no crash, because from this pipeline's
point of view an empty-of-new-rows Notion database is indistinguishable
from "nothing new happened today." **There is no monitoring in this repo
for that external agent's health**, and there can't be without deliberately
building one (e.g. checking `Date found` timestamps for staleness) — not
done today.

## Discord is down / the digest post fails

`pipeline.js`'s `postDigest()` call is wrapped in try/catch — a failure
(outage, bad channel, missing permission) is logged, pushed into `issues`,
and DMed to admins at the end of the run, same as any other pipeline
failure. It does **not** retry, and it does **not** stop the Notion Feed
write, which already happened earlier in the run regardless.

**Startup is different**: `src/index.js`'s `createDiscordClient()` call is
not wrapped the same way — if `client.login()` fails (bad token, Discord
API down at that exact moment, network issue at boot), there is no
logged-in client to DM through at all, so Discord-based alerting
structurally cannot cover this one case. Since this now runs as a GitHub
Actions job rather than an always-on process (see
[architecture.md](./architecture.md#hosting-github-actions)), a login
failure just makes that run's job fail — GitHub's own built-in
"workflow run failed" email (sent to the repo owner by default, no setup
needed) is what surfaces it, and the next day's scheduled run tries again
independently. There's no cross-run backoff or "stop trying after N
failures" logic; every scheduled trigger is a fresh, independent attempt.

## The channel the bot posts to gets deleted

`client.channels.fetch(channelId)` (inside `postDigest()`'s caller in
`pipeline.js`, or `replay-digest.js`) throws when the channel no longer
exists. Caught the same way as any other digest-post failure — logged,
pushed into `issues`, DMed to admins at the end of that run. **Every
future run against that target will fail identically** until the relevant
var is updated (`DISCORD_CHANNEL_ID` for prod — the GitHub Actions secret,
since that's the only place `DISCORD_TARGET=prod` is set;
`TEST_DISCORD_CHANNEL_ID` for a local dev run, in `.env` — see
[discord-integration.md](./discord-integration.md#test-vs-production-channel)),
but at least each run's failure is now surfaced via the admin DM rather
than being silent — no self-check at startup verifies the channel still
exists or that the bot still has `SEND_MESSAGES`/`VIEW_CHANNEL` before
attempting to post, it's discovered by the post itself failing. A local
dev run can't hit this for the *prod* channel at all unless
`DISCORD_TARGET=prod` was set deliberately — see
`discord/target.js`.

## The server's role/permission policy changes and the bot loses access

Same mechanism as the channel-deleted case: `channel.send()` throws a
Missing Access-style error, caught, pushed into `issues`, DMed to admins.
No self-check at startup that verifies permissions ahead of time — the
failure is still discovered by attempting the send, just no longer silent
afterward.

## Notion API is down, rate-limited, or the integration loses access

- **Reading** (`sources/notion.js`): an uncaught error inside
  `fetchOpportunities()` propagates up to `pipeline.js`'s per-source
  try/catch in `scrapeAllSources()` — Notion just becomes "one more source
  that failed this run," logged, other sources unaffected, and the run
  only hard-fails if *every* enabled source fails simultaneously.
- **Writing** (`notion-feed.js`): `writeToFeed()` catches failures
  per-page (one bad row doesn't drop the rest of the batch) and the whole
  call is additionally wrapped in try/catch inside `runPipeline()` — a
  total Notion-write outage degrades to "wrote 0 rows this run, logged
  it," Discord posting still proceeds normally afterward.
- No retry/backoff exists at either layer. A 429 just fails that
  item/source for that run.

## A scraper hangs or the target site's structure changes

Each source module sets its own Playwright navigation timeout (30-60s
depending on the module) and is wrapped in `scrapeAllSources()`'s
per-source try/catch — a hang times out, throws, is caught, logged as a
source failure, and the rest of the pipeline proceeds. A silent structural
change on the source site (selectors stop matching) doesn't throw at
all — it just returns fewer or zero results with no error, which looks
identical to "genuinely nothing new today" from every downstream
consumer's perspective. `work-ua`/`robota-ua`'s Cloudflare-blocking is
exactly this failure mode in practice (see [sources.md](./sources.md)).

## Process crashes mid-write to `data/events.jsonl`

Handled well: `lib/store.js`'s `appendNewEvents()` writes to a temp file
then renames it over the real file (`fs.rename`, atomic on the same
filesystem) — a crash mid-write leaves the temp file orphaned and the real
`events.jsonl` untouched, never truncated/corrupted. This one is a
genuine, deliberate strength, not a gap.

## Two pipeline runs accidentally run at once

Handled at the infrastructure level now: `.github/workflows/daily-digest.yml`
sets `concurrency: { group: daily-digest, cancel-in-progress: false }`,
and GitHub queues/skips overlapping runs of that group natively — this is
a real cross-run guard, not the old in-memory-boolean approach
(`scheduler.js`'s `running` flag) that only protected against overlap
*within a single long-lived process* and did nothing against two separate
`npm start` processes (which happened during development — see git
history around killing leftover `node src/index.js` processes). That
gap doesn't apply to the deployed job any more; it would still apply if
someone ran `npm start` locally twice at once, since local dev has no
concurrency group protecting it.
