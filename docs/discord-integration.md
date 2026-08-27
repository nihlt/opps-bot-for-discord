# Discord integration

**Read [architecture.md](./architecture.md#whats-actually-wired-in) first.**
Two entirely different posting formats exist in this codebase; only one is
live.

## What's live: one embed per new opportunity

`src/discord/post.js` — `createDiscordClient()` logs in with
`DISCORD_BOT_TOKEN` (only `GatewayIntentBits.Guilds` requested).
`postOpportunity(client, opportunity)` builds a classic `EmbedBuilder`
(title=link, color by kind, fields for date/location/payment/company/tags-
as-hashtags/calendar) and sends it to `DISCORD_CHANNEL_ID`. `runPipeline()`
calls this once per new opportunity, 300ms apart, capped to 15 on the very
first run ever (empty store) so the whole historical catalogue doesn't get
dumped into the channel at once.

## What's prototyped but not wired in: the Components V2 digest

`src/discord/digest.js` — `postDigest(channel, opportunities,
{ scoringPopulation })`. Built and unit-tested; demonstrated live via
one-off scripts run manually during development, sending real messages to
the real channel. **`runPipeline()` never calls this.**

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
  [Section]
    {summary or hook, truncated to 400 chars, or omitted entirely}
    {location} · score {N} · {"better than 0.NN" or "one of the best"}
    [Button: "Відкрити" -> opportunity.link]
```

Top 3 by score go in the channel message; the rest go into a thread named
`Ще N можливостей/можливість` (correct Ukrainian pluralization), chunked 5
items per follow-up message in the thread.
