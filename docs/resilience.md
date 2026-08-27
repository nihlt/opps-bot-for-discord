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
dependency) — ranking and gold/gray highlighting (when `digest.js` is used)
keep working normally. `discord/post.js` (the live posting path) and
`discord/digest.js` both show no description line for affected items
rather than falling back to raw scraped text — this is by design, not a
gap. `notion-feed.js`'s `Summary` property is simply omitted from the
write (not set to a placeholder).

**What's NOT handled**: no retry, no backoff, single attempt per pipeline
run. It's an all-or-nothing batch — if the Vertex AI call fails, *every*
item in that run loses its summary, not just a problematic one, because
they're all sent in one call. No alert to the user that summarization is
silently degrading run after run (e.g. if the service account key in
`GOOGLE_APPLICATION_CREDENTIALS` is revoked, or `GEMINI_MODEL`/
`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` stop being a valid
combination) — the only visible symptom is that Discord messages/Notion
rows quietly stop having a `Summary`/description, with the reason sitting
in a log line nobody is necessarily watching.

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

## Discord is down / a single post fails

Inside `runPipeline()`'s posting loop, each `postOpportunity()` call is
individually wrapped in try/catch — one failed send is logged and the loop
continues to the next opportunity. A full Discord outage during the
posting phase would produce a run that scraped and stored everything
correctly but posted 0 messages, with N error lines in the log, and the
process keeps running (cron will try again next scheduled run).

**Startup is different and worse**: `src/index.js`'s `createDiscordClient()`
call is *not* wrapped per-item — if `client.login()` fails (bad token,
Discord API down at that exact moment, network issue at boot), `main()`'s
top-level `.catch()` logs the error and calls `process.exit(1)`. **The
process exits and nothing restarts it** — there is no process supervisor
(no pm2, no systemd unit, no Windows service, no retry loop) configured
anywhere in this repo or documented as a deployment requirement. A
transient outage exactly at boot time means the bot simply stays down
until someone manually re-runs `npm start`.

## The channel the bot posts to gets deleted

`channel.channels.fetch(channelId)` (inside `postOpportunity()` /
`postDigest()`) throws when the channel no longer exists. Caught the same
way as any other per-item post failure — logged, loop continues, pipeline
completes "successfully" having posted 0 messages. **Every single item in
every future run will fail identically** until `DISCORD_CHANNEL_ID` is
updated in `.env` and the process restarted, with no proactive alert
(e.g. a DM to the bot owner) that this has happened — the only signal is
silence in the channel and error lines in a log.

## The server's role/permission policy changes and the bot loses access

Same mechanism and same gap as the channel-deleted case: `channel.send()`
throws a Missing Access-style error, caught per-item, logged, loop
continues. No alerting. No self-check at startup that verifies the bot
still has `SEND_MESSAGES`/`VIEW_CHANNEL` before attempting a run.

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

## Two pipeline processes accidentally run at once

`scheduler.js`'s overlap guard is an **in-memory boolean** inside one
process — it prevents a second cron tick from overlapping a still-running
tick *within that process*, but does nothing if someone accidentally starts
a second `npm start` process (e.g., after a crash, forgetting the old one
might still be limping along, or an interactive test run left orphaned —
this happened during development, see git history / conversation around
killing leftover `node src/index.js` processes). Both processes would
scrape, dedupe against the same file, and could both attempt to post the
same "new" item if they read the store at overlapping times. No file lock,
no PID file, no cross-process guard exists.
