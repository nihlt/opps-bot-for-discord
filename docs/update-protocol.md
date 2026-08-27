# Update protocol

These docs are only useful if they stay true. There's no CI check enforcing
that — this is a discipline, not a guarantee. The rule: **if your change
would make a sentence in one of these files false, fix that sentence in the
same commit as the code change**, not later "when there's time."

## Map: code change → doc(s) to check

| You changed... | Check / update... |
|---|---|
| `config/sources.json`, added/removed a `src/sources/*.js` module | [sources.md](./sources.md) table, [architecture.md](./architecture.md) diagram if the flow itself changed |
| `src/lib/normalize.js` (Opportunity shape, `applyEventPaymentPolicy`, `isFellowship`) | [architecture.md](./architecture.md#opportunity-shape), [sources.md](./sources.md#payment-policy-filter-applies-after-normalization-before-storage), [scoring-and-highlighting.md](./scoring-and-highlighting.md#isfellowship-only-checks-title--tags-not-description) |
| `src/lib/scoring.js` weights/rubric | [scoring-and-highlighting.md](./scoring-and-highlighting.md) — including re-running the calibration check against the current `data/events.jsonl` and updating the "roughly top 10%" claim if it's drifted |
| `src/lib/notion-feed.js`, or either Notion database's schema | [notion-integration.md](./notion-integration.md) |
| `src/discord/post.js` or `src/discord/digest.js` | [discord-integration.md](./discord-integration.md) — **and check whether "what's wired in" in [architecture.md](./architecture.md) is still accurate** |
| `src/pipeline.js` — especially if you wire `digest.js` or `summarize.js` into `runPipeline()` | [architecture.md](./architecture.md#whats-actually-wired-in) table — flip the relevant row, this is the single most important table in these docs to keep honest |
| `src/lib/summarize.js`, `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`/`GEMINI_MODEL`/`GOOGLE_APPLICATION_CREDENTIALS` | [resilience.md](./resilience.md#the-vertex-ai-gemini-api-doesnt-respond-times-out-or-errors), [assumptions-and-caveats.md](./assumptions-and-caveats.md#gemini-summarization-went-through-two-auth-mechanisms-before-it-worked) |
| Any new external dependency (API, scheduled agent, service) | [resilience.md](./resilience.md) — add a section: what happens when it's down, what's NOT handled |
| Fixed a real bug (not a style change) | Consider whether it belongs in [assumptions-and-caveats.md](./assumptions-and-caveats.md) as a "this used to be wrong" note, especially if the bug was subtle enough to recur |
| Deployed this somewhere persistent (VM, container, scheduled task) | [assumptions-and-caveats.md](./assumptions-and-caveats.md#no-process-supervision) and [#no-cross-process-run-guard](./assumptions-and-caveats.md#no-cross-process-run-guard) — note what supervision/locking was actually added, or that there still isn't any |

## Writing style for these docs

- State what the code **actually does**, verified by reading it, not what
  it's "supposed to" or "eventually will" do. If something is built but
  not wired in, say so explicitly (see how often that phrase appears in
  [architecture.md](./architecture.md) — that's intentional, not sloppy).
- When documenting a failure mode, trace it to the actual try/catch (or
  lack of one) in the code. "It's probably fine" is not an acceptable
  substitute for reading `pipeline.js`.
- Cross-link liberally with relative markdown links (`[text](./file.md#anchor)`)
  instead of restating another file's content.
- Keep [PLAN.md](../PLAN.md) as the place for *forward-looking* work
  (backlog, stages not yet built) and this `docs/` folder as the place for
  *what already exists and why*. Don't duplicate between them — link
  instead.

## If you're an AI agent picking this repo up cold

Read [README.md](./README.md) in this folder first, in full, before
touching code. It is short on purpose. Then read whichever specific file
matches the area you're changing, using the table above. Update the docs
as part of your change, not as an afterthought — a future agent (possibly
you, with no memory of this session) will trust these files at face value.
