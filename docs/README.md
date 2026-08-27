# Architecture docs — start here

This folder is a knowledge graph for anyone (human or AI agent) picking up
this repo cold. Read this file first, then follow the links relevant to
what you're about to touch.

## Map

| File | Covers |
|---|---|
| [architecture.md](./architecture.md) | End-to-end data flow, every module, what calls what |
| [sources.md](./sources.md) | Each scraper's contract, quirks, and known failure modes |
| [scoring-and-highlighting.md](./scoring-and-highlighting.md) | The 0-100 heuristic score, percentile color bands, calibration |
| [notion-integration.md](./notion-integration.md) | The two Notion databases, why two, tradeoffs |
| [discord-integration.md](./discord-integration.md) | The Components V2 digest format, and the alerting DM system |
| [resilience.md](./resilience.md) | What actually happens when each dependency fails |
| [assumptions-and-caveats.md](./assumptions-and-caveats.md) | Provisional/known-suboptimal decisions, named honestly |
| [update-protocol.md](./update-protocol.md) | Which doc to touch when you change which code |

## The one fact you must not assume wrong

**Everything in `src/` is wired into `runPipeline()` — there's no more
dormant-but-built code.** `src/pipeline.js` (see
[architecture.md](./architecture.md#whats-actually-wired-in)) scrapes,
dedupes, summarizes via Vertex AI, writes to Notion Feed, and posts the
Components V2 digest (top 3 in the channel + thread overflow,
percentile/gold accent colors) — every run, no per-item embed format left
around unused. `runPipeline()` also collects every problem it hits into
one consolidated admin DM per run via `src/discord/alerts.js`. The bot
itself runs once and exits per invocation; GitHub Actions
(`.github/workflows/daily-digest.yml`) is what triggers that daily, not an
in-repo scheduler.

**What's still genuinely missing, and it's not code**:
`DISCORD_CHANNEL_ID` still needs to point at a real production channel
(currently the test channel used for development) — see
[architecture.md](./architecture.md#whats-actually-wired-in). If you're an
agent picking this up, don't assume that gap is code-shaped; it's a manual
Discord-side step.

## Why this folder exists

The project grew through a long iterative conversation (scaffolding → per-
source scrapers → payment-policy filtering → scoring → Discord formatting
iteration → Notion write-back → LLM summarization), and a lot of the *why*
behind decisions lives only in that conversation history, not in code
comments. This folder is an attempt to make that reasoning durable and
readable without replaying the whole conversation. Update it as you go —
see [update-protocol.md](./update-protocol.md).
