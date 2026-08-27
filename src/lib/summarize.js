const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DESCRIPTION_EXCERPT_LENGTH = 800;

function buildPrompt(opportunities) {
  const items = opportunities.map((o) => ({
    id: o.id,
    title: o.title,
    kind: o.kind,
    location: o.location,
    tags: o.tags,
    description: (o.description || '').slice(0, DESCRIPTION_EXCERPT_LENGTH),
  }));

  return `You are writing one-sentence summaries for a Discord feed of opportunities (hackathons, fellowships, jobs, events) aimed at 1st-4th year Computer Science / AI Systems undergrads at Lviv Polytechnic (LPNU).

For each item below, write ONE concrete sentence describing what the reader actually gets or does by taking part -- skip generic promotional language about the event's scale, history, or prestige. Be specific and factual, not salesy. Write in Ukrainian.

Respond with ONLY a JSON array, no markdown fences, no commentary, in this exact shape:
[{"id": "<id>", "summary": "<one sentence>"}]

Items:
${JSON.stringify(items, null, 2)}`;
}

function extractJsonText(candidateText) {
  // Models sometimes wrap JSON in ```json fences despite instructions not to.
  const fenced = candidateText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : candidateText;
}

/**
 * Asks Gemini for a one-sentence, concrete-benefit summary of each
 * opportunity, in a single batched call. Returns a Map from opportunity id
 * to summary text -- only for ids the model actually returned. Throws on
 * any failure (network, non-2xx, unparseable JSON); callers decide how to
 * degrade (see attachSummaries below).
 */
export async function summarizeOpportunities(
  opportunities,
  { apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL, fetchImpl = fetch } = {},
) {
  if (opportunities.length === 0) return new Map();
  if (!apiKey || !model) throw new Error('GEMINI_API_KEY/GEMINI_MODEL is not set');

  const response = await fetchImpl(`${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(opportunities) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) throw new Error('Gemini response had no text content');

  const parsed = JSON.parse(extractJsonText(candidateText));
  if (!Array.isArray(parsed)) throw new Error('Gemini response JSON was not an array');

  const summaries = new Map();
  for (const item of parsed) {
    if (item?.id && item?.summary) summaries.set(item.id, item.summary);
  }
  return summaries;
}

/**
 * Attaches a `.summary` to each opportunity. On any failure, every
 * opportunity gets `.summary = null` instead of a partial/stale result --
 * callers (see digest.js) treat null as "show nothing", not "fall back to
 * the raw scraped description", per house convention: a failed summary
 * should just be absent, not replaced with recycled promotional filler.
 */
export async function attachSummaries(opportunities, options) {
  if (opportunities.length === 0) return [];

  try {
    const summaries = await summarizeOpportunities(opportunities, options);
    return opportunities.map((o) => ({ ...o, summary: summaries.get(o.id) || null }));
  } catch (error) {
    console.error('[summarize] Gemini call failed, leaving summaries blank:', error.message);
    return opportunities.map((o) => ({ ...o, summary: null }));
  }
}
