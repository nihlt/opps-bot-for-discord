# Discord integration

**Read [architecture.md](./architecture.md) first.** There used to be two
posting formats in this codebase (a classic-embed one-per-item format in
`discord/post.js`, and the Components V2 digest below); `post.js` was
deleted once `digest.js` fully replaced it in `runPipeline()` and nothing
referenced it any more. Only the digest format exists now.

## The Components V2 digest — the only posting path

`src/discord/client.js`'s `createDiscordClient()` logs in with
`DISCORD_BOT_TOKEN` (only `GatewayIntentBits.Guilds` requested).
`src/discord/digest.js`'s `postDigest(channel, opportunities,
{ scoringPopulation })` is called once per pipeline run with that run's new
opportunities. Built, unit-tested, and demonstrated live via one-off
scripts many times during development before being wired into
`runPipeline()` for real.

What it does: sorts every opportunity by `scoreOpportunity()`, posts the
**global top 3** (regardless of category) in one titled channel message —
`**Нові можливості за {date}**`, then each of those 3 as a Components V2
`Container` with a "Відкрити" link button — and, if there's more, opens
**one thread** off that message for everything else, grouped by category
(`categorizeOpportunity()`, `CATEGORY_ORDER = ['Hackathons', 'Events',
'Fellowship Programs', 'Jobs', 'Online Events']`), each category its own
header + chunked follow-up message(s) in the thread. Accent color per item
comes from `percentileColor()` against `scoringPopulation` (see
[scoring-and-highlighting.md](./scoring-and-highlighting.md) for the
"almost always pass the full catalogue, not just today's batch" trap).
Description text is `opportunity.summary || opportunity.hook` — **no
fallback to the raw scraped description**, by explicit design (see below).

### Global top 3, category grouping only for the thread

An earlier version tried the opposite split — top 3 *per category*, each
category its own channel message — after an even earlier attempt to
combine all five categories into one message hit a hard Discord limit:
`COMPONENT_MAX_TOTAL_COMPONENTS_EXCEEDED` (a single message's component
tree, counted recursively, is capped at **40 total** — two fully-populated
categories already sit at ~37). The per-category-messages design avoided
that cap but produced up to 5 separate channel messages per run with no
single obvious "here's today's headline" entry point. Settled on: one
title message with the GLOBAL top 3 (never at risk of the 40-cap — 3 items
is 3 items regardless of how many categories exist) for the "here's what
matters most today" read, and category grouping demoted to organizing the
*thread* (where it was never going to hit the per-message cap either,
since each category's thread message is its own separate message, chunked
at 5 items).

### Category assignment (`categorizeOpportunity()`, priority order)

1. `kind === 'job'` → **Jobs** (unambiguous, checked first).
2. `isFellowship()` (title/tags) → **Fellowship Programs**.
3. `isHackathon()` (`src/lib/normalize.js` — by a hackathon-specific
   `sourceId` (`dou-hackathon`/`kaggle` only) or a title keyword match;
   tags deliberately not consulted, see
   [scoring-and-highlighting.md](./scoring-and-highlighting.md#ishackathon-only-checks-title--dedicated-sourceids-not-tags-or-dou-competition) —
   exported specifically so this, the score bump, and the payment policy
   can never disagree) → **Hackathons**.
4. `location` matches `/online|онлайн/i` → **Online Events**.
5. Everything else → **Events**.

An item that could fit more than one bucket resolves to whichever check
comes first — e.g. an online hackathon lands in **Hackathons**, not
**Online Events**, because Jobs/Fellowship Programs/Hackathons are more
specific signals than the two catch-alls.

### Why Components V2 instead of classic embeds

Discord.js 14.27 (what `npm install` actually resolved to, ahead of the
`^14.15.3` floor in `package.json`) supports the newer Components V2
message-building API (`ContainerBuilder`, `SectionBuilder` with a button
accessory, `SeparatorBuilder`, `TextDisplayBuilder`, sent with
`flags: MessageFlags.IsComponentsV2`). It was chosen deliberately over
classic embeds partway through development because it reads as less
generic/"bot spam" — most Discord bots still use classic embeds, and the
explicit design goal (user's words) was to avoid an "elite" feed looking
like the disposable notification spam nobody reads.

**Hard limit discovered the hard way**: a Components V2 message caps total
displayable text at **4000 characters**, enforced server-side
(`DiscordAPIError[50035] COMPONENT_DISPLAYABLE_TEXT_SIZE_EXCEEDED`). This
is why `digest.js` truncates any description/summary to 400 chars — hit in
live testing with a real ~1500-char scraped description before the cap was
added.

### Visual design decisions, in order, and why they changed

1. Started with per-category embeds, one colored embed per category
   (Hackathons/Fellowships/Jobs), emoji in headers, playful multi-color
   palette (blurple/orange/green).
2. **No emoji, ever** — explicit user preference, stated once, applies
   everywhere in this codebase's user-facing Discord output.
3. Palette collapsed to a **single accent color family** instead of
   per-category colors — a rainbow of category colors reads as "bot
   notification system," a single restrained accent reads as "one curated
   publication." This is the same reasoning that led to percentile-based
   banding later: fewer, more meaningful visual signals beat more, weaker
   ones.
4. First attempt at a dark accent (`#1B263B`-ish navy) was **invisible on
   Discord's dark theme** — the accent bar renders against Discord's own
   near-black embed background, so a too-dark color has no contrast.
   Corrected to lighter, more saturated tones, then eventually to the
   percentile-banded gray/gold scheme, whose *light* end deliberately
   avoids pure white for the mirror-image reason (vanishes on light
   theme).
5. Plain-text (`content`, no embed) was tried explicitly to answer "what
   does the most minimal, least-bot-like format look like." Two things
   discovered live: masked markdown links (`[text](url)`) render as
   clickable in embeds/Components V2 but **not in plain message content**
   (Discord disables this outside embeds/components, anti-phishing); and a
   bare URL in plain content triggers Discord's own auto-unfurl link
   preview, which needs to be suppressed by wrapping it in `<...>` if you
   don't want the preview to dominate the message.
6. Descriptions moved from "first N characters of the raw scraped text" to
   "first 1-3 sentences" (avoid mid-word chops) to, finally, **LLM-
   generated one-sentence summaries only, with no raw-description fallback
   at all** — raw scraped descriptions are almost always promotional
   filler from the source site ("a conference that for the 13th time will
   gather leading experts...") rather than what the reader actually gets,
   and the explicit decision was that showing nothing beats showing that.

### Failure-mode behavior baked into the format itself

If Gemini summarization fails or hasn't run, `opportunity.summary` and
`opportunity.hook` are both absent/null, and `digest.js` simply omits the
description line — title, link button, and the location/domain meta line
still render. This was an explicit design requirement ("не
виводити той useless опис-текст а просто прибрати його" — don't show that
useless description text, just remove it), not an accident of how the code
happens to behave. See [resilience.md](./resilience.md) for the full list
of what happens when each dependency is down.

## Formatting reference (current digest.js output shape)

Main channel message (always exactly one per run, if there's anything to post):

```
[TextDisplay] **Нові можливості за {D MMMM, e.g. "28 серпня" -- no year}**
[Container, accent = percentileColor(score, scoringPopulation) or none]
  **{title}**{ · $ if hasMoneyPrize(opportunity)}
  [Section, or a plain text block if opportunity.link is missing]
    {summary or hook, truncated to 400 chars, or omitted entirely}

    {location} · from {domain} · дедлайн: {DD.MM}
    [Button: "Відкрити" -> opportunity.link]
... (global top 3 by score, small dividers between them -- not top 3 per category)
```

The title line's date defaults to `new Date()`; `postDigest(channel,
opportunities, { date })` accepts an override for tests or a deliberate
backfill/retrospective run (see
[architecture.md](./architecture.md#which-items-actually-get-posted-digest_lookback_days)
for `DIGEST_LOOKBACK_DAYS`, the other lever for a retrospective digest).
No year in the title by design — a daily digest never needs one to
disambiguate.

`дедлайн: {DD.MM}` is `opportunity.dateNormalized` in short numeric form
(no year, same reasoning), omitted entirely when there's no date. This is
literally the event's own date/deadline field, not a separate "when did we
find this" fact (see [architecture.md](./architecture.md#opportunity-shape)
for `firstSeenAt`, which is a different field entirely and isn't shown here).

The `· $` suffix marks a hackathon/competition/fellowship that states an
actual money figure — see
[scoring-and-highlighting.md](./scoring-and-highlighting.md#the-payable-checkbox--the--marker)
for exactly what counts (deliberately conservative: a vague "generous
stipend" doesn't qualify, a job's salary never does).

The raw score and percentile ("score 60 · better than 0.73") used to be
printed on this meta line too. Removed per explicit user request after it
surfaced a real scoring problem live: several djinni jobs showed the
*exact same* score/percentile despite being different postings (see
[scoring-and-highlighting.md](./scoring-and-highlighting.md#job-scores-used-to-collide-constantly--fixed-by-adding-real-signal-not-by-faking-one)) —
seeing identical numbers repeated read as noise, not useful signal. The
underlying score still drives everything else (sort order, the accent
color band, which 3 items make the top 3) — only the visible text is gone.

`{domain}` is `opportunity.link`'s hostname (`www.` stripped), omitted if
the link is missing or unparseable. There's a blank line between the
summary/hook and the meta line, not just a newline — reads as two visually
distinct pieces of information. The Gemini summarization prompt
(`lib/summarize.js`) explicitly requires prize/stipend figures to sit at
the very start or end of the sentence (never mid-sentence, to survive
skim-reading) and always carry a currency mark, since "who opens an essay
contest link if they don't know 1 student + 1 teacher win $1000" was the
motivating case that got this added.

**Thread** (only created if there's more than the global top 3): named
`Ще N можливостей/можливість` (correct Ukrainian pluralization, N = total
overflow count across every category), off the main message. Inside, each
non-empty category (in `CATEGORY_ORDER`) gets its own bold uppercase
header (`**HACKATHONS**`, etc.) followed by that category's remaining
items, chunked 5-per-follow-up message so a large category doesn't produce
one giant thread message.

## Admin DM alerts (now sent every run, not just on failure)

`src/discord/alerts.js`'s `notifyAdmins(client, message)` DMs every user id
in `ADMIN_DISCORD_USER_IDS` (comma-separated). Policy, per explicit user
decision, is **alert on every failure, no exceptions** — but batched into
one DM per pipeline run (listing every issue found) rather than one DM per
problem. `runPipeline()` collects issues from every stage (source
failures, Vertex AI summarization failures, Notion write failures, the
digest post itself failing) into an array.

**`notifyAdmins()` is now called unconditionally at the end of every
run**, not only when `issues` is non-empty — per explicit request to see
LLM spend every time, not just when something breaks (see
[architecture.md](./architecture.md#llm-usage-cost-tracking) for the
token/cost tracking itself). The message always ends with a "Вартість
LLM" section (this run / last 7 days / last 30 days / all-time); issues,
if any, are listed *above* that section so they're not buried under the
routine cost line. `index.js` has its own fallback alert for a fatal
error that somehow escapes `runPipeline()`'s own handling entirely,
best-effort only (it needs a logged-in client to send through).

A source returning `[]` (e.g. `work-ua`'s permanent Cloudflare block, see
[sources.md](./sources.md)) is **not** a failure for alerting purposes —
only a thrown error counts. This was deliberate: alerting on every
already-known-broken source's empty result would DM the admin daily about
something that isn't new information.

`notifyAdmins()` never throws — a DM failure (closed DMs, no mutual server,
bad id) is logged and skipped per-recipient, so it can never mask the
original error it's reporting. If Discord login itself is what failed
(`index.js`), there's no logged-in client to alert through at all — see
[resilience.md](./resilience.md).
