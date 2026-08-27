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

What it does: sorts by `scoreOpportunity()` descending, puts the top 3 in
the channel message itself (Components V2 `Container`s with a "Відкрити"
link button per item), pushes everything else into a **thread** off that
message, chunked 5-per-follow-up. Accent color per item comes from
`percentileColor()` against `scoringPopulation` (see
[scoring-and-highlighting.md](./scoring-and-highlighting.md) for the
"almost always pass the full catalogue, not just today's batch" trap).
Description text is `opportunity.summary || opportunity.hook` — **no
fallback to the raw scraped description**, by explicit design (see below).

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
description line — title, link button, and the location/score/percentile
meta line still render. This was an explicit design requirement ("не
виводити той useless опис-текст а просто прибрати його" — don't show that
useless description text, just remove it), not an accident of how the code
happens to behave. See [resilience.md](./resilience.md) for the full list
of what happens when each dependency is down.

## Formatting reference (current digest.js output shape)

```
[Container, accent = percentileColor(score, scoringPopulation) or none]
  **{title}**
  [Section, or a plain text block if opportunity.link is missing]
    {summary or hook, truncated to 400 chars, or omitted entirely}

    {location} · from {domain} · score {N} · {"better than 0.NN" or "one of the best"}
    [Button: "Відкрити" -> opportunity.link]
```

`{domain}` is `opportunity.link`'s hostname (`www.` stripped), omitted if
the link is missing or unparseable. There's a blank line between the
summary/hook and the meta line, not just a newline — reads as two visually
distinct pieces of information. The Gemini summarization prompt
(`lib/summarize.js`) explicitly requires prize/stipend figures to sit at
the very start or end of the sentence (never mid-sentence, to survive
skim-reading) and always carry a currency mark, since "who opens an essay
contest link if they don't know 1 student + 1 teacher win $1000" was the
motivating case that got this added.

Top 3 by score go in the channel message; the rest go into a thread named
`Ще N можливостей/можливість` (correct Ukrainian pluralization), chunked 5
items per follow-up message in the thread.

## Admin DM alerts

`src/discord/alerts.js`'s `notifyAdmins(client, message)` DMs every user id
in `ADMIN_DISCORD_USER_IDS` (comma-separated). Policy, per explicit user
decision, is **alert on every failure, no exceptions** — but batched into
one DM per pipeline run (listing every issue found) rather than one DM per
problem. `runPipeline()` collects issues from every stage (source
failures, Vertex AI summarization failures, Notion write failures, the
digest post itself failing) into an array and sends a single alert at the
end if it's non-empty; `index.js` has its own fallback alert for a fatal
error that somehow escapes `runPipeline()`'s own handling, best-effort
only (it needs a logged-in client to send through).

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
