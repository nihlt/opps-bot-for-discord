# Sources

See [architecture.md](./architecture.md) for how these fit into the
pipeline. Every module exports `async function fetchOpportunities(sourceConfig)
-> Promise<Opportunity[]>`, manages its own Playwright browser lifecycle
(launch/close per call, no shared browser — a crash in one source can't
take down another), and calls `normalizeOpportunity()` before returning.

| id | module | kind | enabled | notes |
|---|---|---|---|---|
| `notion` | `notion.js` | event | yes | Reads the user's hand-curated "Opportunities" DB. Deadline maps straight to `dateNormalized`/`dateEndNormalized`, bypassing free-text date parsing. **Never written back to** — see [notion-integration.md](./notion-integration.md). |
| `dou-ai` / `dou-hackathon` / `dou-competition` | `dou-calendar.js` | event | yes | One module, three configs (`tag` field on `sourceConfig`). Slowest source (~110s for `dou-ai` alone) — visits each event's detail page individually, no cache. |
| `ain` | `ain-opportunities.js` | event | yes | Parses AIN's weekly digest articles, splits by `<h2>`. If no in-article link is found, `link` falls back to the digest article's own URL — the only source with this fallback behavior. |
| `kaggle` | `kaggle-competitions.js` | event | yes | `payment` here is **prize money**, not a cost to attend — explicitly exempted from the payment-policy filter (see [scoring-and-highlighting.md](./scoring-and-highlighting.md)). Deadline comes from a tooltip hover, parsed by `parseDate()`'s Kaggle-specific `M/D/YYYY, h:mm:ss AM/PM` branch. |
| `kse-news` | `kse-news.js` | event | yes | Requires the link to contain `/university-news/`; drops anything without one. |
| `djinni` | `djinni.js` | job | yes | `location` field is actually a mixed bag: remote/office status + years of experience + English level + category, all concatenated (e.g. `"Тільки віддалено, 1 рік досвіду, Англійська - B2"`). `lib/scoring.js` parses years-of-experience out of this same string. Has a good/bad keyword title classifier from `data/job-keywords.json`. |
| `work-ua` | `work-ua.js` | job | yes | Currently returns **0 results live** — the site serves a Cloudflare challenge page to headless Chromium. Fails safe (returns `[]`, doesn't throw). Not disabled in config on the theory this may be intermittent / IP-dependent; revisit if it's permanently blocked. |
| `robota-ua` | `robota-ua.js` | job | **no** | `enabled: false` in `config/sources.json`, `disabledReason: "Cloudflare blocks headless access"`. Ported for completeness; not expected to ever return results while the block holds. |

## Payment-policy filter (applies after normalization, before storage)

`applyEventPaymentPolicy()` in `lib/normalize.js` runs on every `event`-kind
opportunity except `kaggle` (see above) and drops anything that looks like
a paid course/event (a currency amount in `payment`, no "free" indicator)
**unless** `isFellowship()` matches — fellowships keep their payment field
(it's a stipend amount, not a cost). Free events get `payment` cleared to
`null` regardless — the house rule is "only fellowships ever show a payment
figure." `kind: 'job'` opportunities are untouched (salary has its own
semantics, unrelated to this rule).

## Adding a new source

1. Add an entry to `config/sources.json` (`id`, `module`, `kind`, `enabled`, `url`).
2. Write `src/sources/<name>.js` exporting `fetchOpportunities(sourceConfig)`.
3. Call `await loadKeywordRules()` (from `lib/normalize.js`) before calling
   `normalizeOpportunity()` — it's cheap, safe to call every time, and
   without it tag/location keyword inference silently returns nothing.
4. Update this table.
