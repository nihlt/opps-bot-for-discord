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
- Офлайн, за зручністю (не жорсткий фільтр, а орієнтир для пріоритету):
  1) Україна, 2) ~6 год їзди/льоту від Львова (Польща, Словаччина,
  Угорщина, Румунія, Молдова — напр. Варшава), 3) решта Європи,
  4) решта світу.
- Хакатони та fellowship-и шукай і показуй НЕЗАЛЕЖНО від відстані, по
  всьому світу — не обмежуй тільки Європою чи "помітними" подіями. Але
  чим далі й складніше дістатись, тим нижчий пріоритет: у розділі "Нові
  можливості" впорядковуй записи за зручністю (Україна/онлайн → ~6-год
  зона → решта Європи → решта світу), а не як знайшлось.
- Для КОЖНОЇ офлайн-можливості поза Україною обов'язково перевір і вкажи
  в Summary: чи потрібна віза громадянину України для цієї країни, і чи
  допомагають організатори з візовим процесом (запрошення, лист
  підтримки, покриття збору, консультація/супровід). Якщо віза потрібна
  і жодної допомоги не згадано — прямо напиши це в Summary як істотний
  бар'єр, а не другорядну деталь (напр. "потрібна віза США, підтримки
  від організаторів не згадано — процес самостійний і по строках
  непередбачуваний"). Мотивуючий приклад: Horizon Fellowship
  (https://horizonpublicservice.org/applications-open-for-2027-horizon-fellowship-cohort/)
  виглядає привабливо, але без чіткої візової підтримки реалістичність
  під питанням — саме це треба вловлювати одразу, а не вже після подачі.

КРОКИ:
1. Зроби пошук в інтернеті за ключовими запитами (варіюй і українською,
   і англійською). Підставляй актуальний і наступний рік відносно
   сьогоднішньої дати щоразу заново — НЕ хардкодь конкретний рік у самих
   запитах (інакше доведеться вручну оновлювати щороку): "agentic AI
   hackathon", "AI summer school fellowship [рік]", "AI fellowship funded
   travel visa sponsorship", "programming hackathon Europe/Ukraine/
   Warsaw", "AI meetup Lviv/Warsaw", "agentic AI internship", "LLM
   research seminar funded", "AI hackathon [рік] international
   participants" і подібні.
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
     фінансування". Для офлайн-можливостей поза Україною — сюди ж, коротко,
     інформація про візу (потрібна чи ні, чи допомагають організатори),
     див. розділ ГЕОГРАФІЯ вище.
4. Перевір усі записи зі статусом "Interested - need to apply":
   - якщо Deadline настає протягом 7 днів АБО дедлайну немає, але
     запис не оновлювався понад 5 днів — познач як "потребує уваги".

ФОРМАТ ВІДПОВІДІ (тільки текст, без зайвого):
### Нові можливості
(впорядкуй за зручністю: Україна/онлайн → ~6-год зона від Львова →
решта Європи → решта світу; в межах групи — простіші з візою вище)
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
6. **Geography widened from "~6h zone or bust" to "all of Europe, plus
   hackathons/fellowships worldwide"** — the ~6h-from-Lviv zone is still
   called out as the most convenient tier, but is no longer the ceiling
   for what gets searched. Motivating case: a real US fellowship
   (Horizon Public Service) is worth surfacing even though it's far, as
   long as the visa reality is stated plainly (see next point) rather
   than the opportunity being silently excluded or silently shown as if
   it were as easy to reach as a Warsaw meetup.
7. **Visa/legal-feasibility check added, mandatory for every offline item
   outside Ukraine** — not just distance, but whether a Ukrainian citizen
   needs a visa for that country and whether the organizer actually helps
   (invitation letter, fee coverage, guidance) versus leaving the
   applicant to sort it out alone. This was invisible before: an
   opportunity could look equally attractive whether it needed zero
   paperwork (Poland, visa-free) or a multi-month US visa process with no
   organizer support, and the report gave no signal either way.
8. **Report ordering now reflects distance/feasibility instead of find
   order** — Ukraine/online first, then the ~6h zone, then the rest of
   Europe, then the rest of the world, with easier-visa items surfacing
   above harder ones within a tier. There's no numeric `Score` property
   on this database (unlike "Opportunities Feed," which has one) — this
   was implemented as explicit sort/grouping guidance and required
   Summary content instead of a new field, to keep this change scoped to
   prompt wording. A dedicated property (e.g. a distance/feasibility
   tier) could be added later the same way `Payable`/`Date Found` were
   added to the Feed schema, if free-text ordering proves not enough.
9. **Year no longer hardcoded into search queries** ("AI summer school
   fellowship 2026" → "AI summer school fellowship [рік]," computed fresh
   from the current date each run) — the old wording would have quietly
   gone stale every January without someone remembering to edit it by hand.
10. **Duplicate detection left as-is, deliberately** — the existing Link
    + Name check (see point 2) stays unchanged for now. Flagged as an
    open question rather than expanded further, pending real duplicate
    cases to look at before deciding what (if anything) needs fixing.
