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
| [discord-integration.md](./discord-integration.md) | Posting formats — what's live vs. what's prototyped but unwired |
| [resilience.md](./resilience.md) | What actually happens when each dependency fails |
| [assumptions-and-caveats.md](./assumptions-and-caveats.md) | Provisional/known-suboptimal decisions, named honestly |
| [update-protocol.md](./update-protocol.md) | Which doc to touch when you change which code |

## The one fact you must not assume wrong

**The fancy stuff is built and tested but not turned on.** `src/pipeline.js`
today (see [architecture.md](./architecture.md#whats-actually-wired-in))
scrapes, dedupes, writes to Notion Feed, and posts **one plain embed per new
opportunity** via `src/discord/post.js`. Everything else you'll find in the
repo — the Components V2 digest (`src/discord/digest.js`), the
percentile/gold accent colors (`src/discord/score-color.js`), the
Gemini summarization stage (`src/lib/summarize.js`) — exists, has tests, and
has been demoed live to the real Discord channel via throwaway scripts, but
`runPipeline()` does not call any of it yet. If you're an agent asked to
"improve the digest" or "make the bot smarter," check whether the thing
you're improving is even reachable from `index.js` before assuming it
affects production behavior.

## Why this folder exists

The project grew through a long iterative conversation (scaffolding → per-
source scrapers → payment-policy filtering → scoring → Discord formatting
iteration → Notion write-back → LLM summarization), and a lot of the *why*
behind decisions lives only in that conversation history, not in code
comments. This folder is an attempt to make that reasoning durable and
readable without replaying the whole conversation. Update it as you go —
see [update-protocol.md](./update-protocol.md).
