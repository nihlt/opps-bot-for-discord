# Daily opportunity search — the external Claude agent's prompt

**This file is not run by this repository.** It's the full prompt text
for a **separately-scheduled Claude session** (the user's own `/schedule`
setup, configured outside this codebase — see
[notion-integration.md](./notion-integration.md#a-note-on-how-opportunities-actually-gets-new-rows)
and [assumptions-and-caveats.md](./assumptions-and-caveats.md#agentic-web-search-is-a-scheduled-prompt-not-an-api-integration)).
Saved here, in this repo's docs, purely because that agent writes
directly into the "Opportunities" Notion database that `src/sources/notion.js`
reads as one of this pipeline's own 9 sources — its output format has a
real, direct effect on what this codebase's scoring and digest do with
that data. Keep this file's prompt and the actual `/schedule` config in
sync by hand; nothing here enforces that automatically.

## Why this prompt's exact wording matters to this repo

- **`Type` becomes a tag** on every Opportunity object built from this
  source (`tags: uniqueStrings([row.type, ...])` in `src/sources/notion.js`),
  and `src/lib/scoring.js`'s `isHackathon()`/`isFellowship()` — which also
  drive `discord/digest.js`'s category grouping — scan that tag text with
  a fixed keyword pattern. A `Type` value outside the six the database
  actually has as select options, or a typo, silently drops that row into
  the generic "Events" bucket at the lowest score tier instead of
  Hackathons/Fellowship Programs, with no error anywhere.
- **`Location` is read as free text, verbatim**, into the same `location`
  field events from every other source use — `scoreOpportunity()`'s
  Lviv/online bonus and `digest.js`'s "Online Events" category both do a
  substring match against it (`львів|lviv`, `online|онлайн`). Writing
  "Львів" / "Online" gets recognized; writing something else that means
  the same thing in different words (e.g. "дистанційно", a city
  abbreviation) won't be.
- **`Date found` needs no prompt instruction at all** — it's a Notion
  auto-`created_time` property, stamped the moment a page is created,
  regardless of who/what created it. (Every *other* source this pipeline
  scrapes didn't have an equivalent until `lib/store.js`'s
  `appendNewEvents()` was changed to stamp one at persist-time — see
  [architecture.md](./architecture.md#opportunity-shape).)
- **`Summary`** already exists as a schema field, documented as "meant to
  be written by Claude, via the user's separately-scheduled agent" (see
  [notion-integration.md](./notion-integration.md#why-two-summaries-two-different-models))
  — but the prompt in use before this pass never actually instructed
  writing it. This pipeline doesn't read it back yet either way (a known,
  documented gap, not something this prompt change fixes) — but filling
  it is still worth doing since it's the intended design and costs
  nothing extra to write while the agent already has the context open.

## The prompt

```
Ти шукаєш нові можливості для мене: хакатони, літні школи, fellowship-и,
стажування, офлайн мітапи/зустрічі, конференції — все, що стосується
програмування, AI, agentic AI.

NOTION-БАЗА (використовуй саме цю, не створюй нову):
https://app.notion.com/p/875e45d5c3ec4eb09186ff68c5431c02
Поля: Name, Link, Type (Hackathon/Summer School/Fellowship/Internship/
Meetup/Conference), Location, Deadline, Funded (checkbox), Summary,
Status (New / Interested - need to apply / Applied-Registered / Done /
Skip). Не вигадуй нових значень для Type чи Status — тільки ті, що
перелічені вище. "Date found" Notion заповнює сам при створенні рядка —
нічого туди не пиши.

ГЕОГРАФІЯ:
- Онлайн-формат завжди в межах пошуку, незалежно від фінансування чи
  теми — нульова вартість подорожі сама по собі знімає географічне
  обмеження.
- Пріоритет для офлайн: Україна + локації в межах ~6 год їзди/льоту від
  Львова (Польща, Словаччина, Угорщина, Румунія, Молдова — напр. Варшава).
- Без жорсткого обмеження для офлайн: якщо можливість оплачує проїзд і/або
  проживання, або це помітна подія по agentic AI / AI alignment —
  шукай і показуй незалежно від локації.

КРОКИ:
1. Зроби пошук в інтернеті за ключовими запитами (варіюй і українською,
   і англійською): "agentic AI hackathon", "AI summer school fellowship
   2026", "AI fellowship funded travel", "programming hackathon Poland/
   Ukraine/Warsaw", "AI meetup Lviv/Warsaw", "agentic AI internship",
   "LLM research seminar funded" і подібні.
2. Відкрий Notion-базу за посиланням вище. Порівняй знайдені результати
   з УСІМА існуючими записами (незалежно від Status, включно з Done і
   Skip) за полем Link. Якщо точного збігу немає, додатково звір Name —
   якщо назва по суті та сама подія (інше посилання, utm-параметр,
   дзеркало) — це теж не нове, пропусти.
3. Для кожної справді нової можливості — додай рядок у базу зі статусом
   "New" і заповненими полями:
   - Name, Link,
   - Location — пиши як реальну назву міста (напр. "Варшава", "Львів")
     або буквально "Online" для повністю дистанційного формату; цей
     текст автоматично читає скоринг/категоризація в іншій системі, тож
     формулювання має бути послідовним, не довільним,
   - Type — один із шести перелічених вище; якщо це змагання/конкурс, а
     не класичний хакатон, все одно став "Hackathon" (найближчий
     відповідник із доступних значень),
   - Deadline, Funded,
   - Summary — ОДНЕ конкретне речення: що людина реально отримує чи
     робить, без промо-риторики про масштаб/історію події. Якщо є приз,
     стипендія чи покриття витрат — обов'язково вкажи конкретну суму з
     позначкою валюти на початку або в кінці речення (напр. "$1000 для
     учасника" або "покриває проїзд + проживання"), а не просто "є
     фінансування".
4. Перевір усі записи зі статусом "Interested - need to apply":
   - якщо Deadline настає протягом 7 днів АБО дедлайну немає, але
     запис не оновлювався понад 5 днів — познач як "потребує уваги".

ФОРМАТ ВІДПОВІДІ (тільки текст, без зайвого):
### Нові можливості
- [Назва](посилання) — тип, локація, дедлайн (якщо є)
(якщо нічого нового — напиши "Сьогодні нічого нового")

### Нагадування
- [Назва](посилання) — дедлайн через N днів / давно без руху
(якщо нема — не виводь цей розділ)

Не показуй записи, які вже є в базі і не змінились. Не дублюй вчорашній звіт.
```

## What changed from the original, and why

1. **Online is now unconditionally in scope for geography**, not just when
   funded or a "notable AI alignment event." The original phrasing left a
   gap: a fully remote event has zero travel cost by definition, so it
   shouldn't need the same funded/prominence exception offline events do
   to bypass the distance rule.
2. **Duplicate check widened**: compare against *every* existing row
   (including `Done`/`Skip`, not just active statuses) and, when the
   `Link` doesn't match exactly, also compare `Name` for the same
   real-world event under a different URL. Exact-`Link`-only comparison
   was the whole check before — enough to miss a tracked-link variant of
   something already skipped on purpose.
3. **`Type` mapping for competitions clarified**: the schema has no
   "Competition" option, so an AI competition that isn't a classic
   hackathon now explicitly maps to `Hackathon` — the closest available
   value, and consistent with how this repo's own `isHackathon()` already
   treats "змагання"/"competition" as hackathon-adjacent for scoring.
4. **`Location` formatting guidance added** — write a real city name or
   literally `Online`, not a paraphrase — because this text is consumed
   verbatim downstream by this repo's own keyword-matching scoring and
   category logic (see above), not just displayed to a human.
5. **`Summary` added as a field to fill**, one concrete sentence, no
   promotional filler, prize/funding figures explicit with a currency
   mark — this mirrors the exact house style already enforced for this
   repo's *own* Gemini-written summaries (`src/lib/summarize.js`), for
   consistency between the two systems even though they use different
   models. This was already the documented intent for this field; the
   prompt just never asked for it.
