# Assumptions and caveats

Things this project currently does that work, but are provisional,
hand-tuned, or arguably not the most efficient/robust available approach.
Named honestly so a future pass (human or agent) doesn't mistake "this is
how it's always been done" for "this was carefully chosen as optimal."

## "Agentic web search" is a scheduled prompt, not an API integration

The mechanism that's supposed to find *new* candidate opportunities for the
user's personal "Opportunities" Notion database is a **scheduled Claude
session prompt** (the user's own `/schedule` setup, outside this repo), not
a real web-search API call this codebase makes. It's real and it works, but
it means: no rate limits or costs visible to this codebase, no
programmatic way to verify it ran or ran well, no retry logic possible
from here (this repo has no handle on that process at all), and its output
quality depends entirely on how well that separate prompt is written —
something this codebase can't test, version, or review. See
[resilience.md](./resilience.md#the-web-search-the-users-separately-scheduled-claude-agent-doesnt-run-or-comes-back-empty).

## The heuristic score is not an LLM judgment

`scoreOpportunity()` is regex/keyword rules, hand-calibrated against one
historical snapshot (see
[scoring-and-highlighting.md](./scoring-and-highlighting.md)). It's fast,
free, and deterministic — good properties — but it cannot understand
nuance an LLM could (e.g., "this hackathon's prize structure heavily favors
teams with prior ML competition experience, which most 1st-years won't
have" is invisible to a keyword match). The user's separate Claude-based
scoring (on the *other* database) is expected to be smarter but isn't fed
back into this pipeline's own `Score`/ranking at all today.

## No expiry filtering anywhere

Nothing in `lib/store.js`, `lib/scoring.js`, or `discord/digest.js` checks
`dateNormalized`/`dateEndNormalized` against "today" to exclude opportunities
whose deadline has already passed. `data/events.jsonl` only ever grows.
This means: the scoring population used for percentile ranking (see
[scoring-and-highlighting.md](./scoring-and-highlighting.md#the-scoringpopulation-trap))
silently accumulates stale entries forever, and nothing would stop a
digest from resurfacing/ranking against a hackathon that happened six
months ago.

## Two databases, two summarizers, no de-dup

See [notion-integration.md](./notion-integration.md#why-two-databases-the-honest-tradeoff)
for the full tradeoff. The short version: this was a deliberate choice to
protect the user's personal curated tracker from being flooded, accepted
knowingly with the cost of zero cross-database dedup or linking.

## The Components V2 digest is fully built and demoed, but not live

Repeated for emphasis because it's the single easiest wrong assumption to
make reading this codebase: `postDigest()`, the percentile/gold accent
colors, and the whole "top 3 + thread overflow" UX exist, are tested, and
were shown working against the real Discord channel — but `runPipeline()`
still posts the older one-embed-per-item format via `discord/post.js`. See
[architecture.md](./architecture.md#whats-actually-wired-in).

## Gemini summarization went through two auth mechanisms before it worked

`lib/summarize.js` was first built against the plain Generative Language
API (`?key=GEMINI_API_KEY` query param). Live testing against the real
`.env` value returned `401 UNAUTHENTICATED` — that key's format (`AQ....`)
doesn't match a standard AI Studio key (`AIzaSy...`), and it turned out to
be provisioned for Vertex AI instead. Rewritten to use Vertex AI with
OAuth2 access tokens resolved from `GOOGLE_APPLICATION_CREDENTIALS`
(service account JSON) via the `google-auth-library` package, sent as a
`Bearer` header rather than a query param. **Confirmed working live**
against `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION=global`/
`GEMINI_MODEL=gemini-3.7-flash` — `gemini-3.7-flash` is a real, reachable
model id on this Vertex AI project. This is now wired into
`runPipeline()`: every new batch gets summarized via a single Vertex AI
call before Notion write and Discord post (see
[architecture.md](./architecture.md)).

If `GOOGLE_APPLICATION_CREDENTIALS` ever points at a missing/expired/
revoked service account, or the project/location/model combination stops
being valid, summarization degrades exactly as described in
[resilience.md](./resilience.md#the-vertex-ai-gemini-api-doesnt-respond-times-out-or-errors) —
blank summaries, no crash, no alert.

## No process supervision

Nothing restarts the bot if it crashes (see
[resilience.md](./resilience.md#discord-is-down--a-single-post-fails)).
Whatever environment this eventually runs in (a persistent VM, a
container, a scheduled task) needs its own restart-on-crash mechanism —
this repo doesn't provide or assume one.

## No cross-process run guard

The overlap guard is in-memory, single-process only. See
[resilience.md](./resilience.md#two-pipeline-processes-accidentally-run-at-once).
If this is ever deployed somewhere that could plausibly start two
instances (e.g. a container orchestrator doing a rolling restart without
waiting for the old instance to exit), this needs a real lock (file lock,
Notion/DB-based lock, whatever fits the deployment target).

## `work-ua` stays "enabled" despite currently returning zero results

A judgment call, not a bug: `work-ua` is blocked by Cloudflare exactly like
`robota-ua`, but was left `enabled: true` on the theory that the block
might be intermittent or IP-dependent, versus `robota-ua`'s block which
was already known/permanent when it was ported. Revisit if this proves to
be a permanent block too — see [sources.md](./sources.md).
