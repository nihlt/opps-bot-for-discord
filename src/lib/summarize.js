import { GoogleAuth } from 'google-auth-library';

// Real descriptions run up to ~4000 chars, and prize/stipend amounts are
// often mentioned near the end (e.g. an essay contest's $1000 prize sat
// at character 3524 of a 3966-char description) -- 800 was silently
// cutting that off before the model ever saw it. Gemini's context window
// comfortably fits this per item even across a full batch.
const DESCRIPTION_EXCERPT_LENGTH = 4000;

let cachedAuth;

/**
 * Resolves an OAuth2 access token from Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS in .env points at a service account
 * JSON). Lazily constructed so importing this module never requires
 * credentials to exist -- only calling it for real does.
 */
async function defaultGetAccessToken() {
  if (!cachedAuth) cachedAuth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const client = await cachedAuth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('GoogleAuth did not return an access token');
  return token;
}

function vertexUrl({ project, location, model }) {
  // Vertex AI's "global" location uses the bare host, unlike regional
  // locations which get a "{region}-" prefix.
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

function buildPrompt(opportunities) {
  const items = opportunities.map((o) => ({
    id: o.id,
    title: o.title,
    kind: o.kind,
    location: o.location,
    tags: o.tags,
    payment: o.payment,
    description: (o.description || '').slice(0, DESCRIPTION_EXCERPT_LENGTH),
  }));

  return `You are writing one-sentence summaries for a Discord feed of opportunities (hackathons, fellowships, jobs, events) aimed at 1st-4th year Computer Science / AI Systems undergrads at Lviv Polytechnic (LPNU).

For each item below, write ONE concrete sentence describing what the reader actually gets or does by taking part -- skip generic promotional language about the event's scale, history, or prestige. Be specific and factual, not salesy. Write in Ukrainian.

If the item is a hackathon, competition, or fellowship AND it mentions a
prize, award, or stipend amount (in the "payment" field or the
description), you MUST include that concrete figure in the summary --
e.g. "$1000 для студента і викладача", "приз 100 000 грн". This is the
single most decisive fact for whether someone bothers to open the link,
so never drop it silently even if the rest of the sentence has to be
shorter to fit. Place the money figure at the very START or the very END
of the sentence, never buried in the middle -- readers skim, and a number
in the middle gets lost. Always include the currency symbol/code (₴, $,
грн, USD) right next to the number, never a bare digit -- the currency
mark itself is part of what catches the eye.

You must ALSO judge whether each item is actually relevant to this specific
audience (1st-4th year CS / AI Systems undergrads at LPNU):

RELEVANT: hackathons and coding/ML competitions; fellowships, grants,
scholarships; tech jobs, internships, trainee programs (software
engineering, data science, ML, AI); tech conferences, workshops, or courses
on programming/AI/ML/data; CS/STEM research or exchange programs.

NOT relevant (mark "relevant": false), even if a tech company organizes or
sponsors it: generic sports events, charity runs, cultural/social/community
events, generic business/entrepreneurship events with no CS angle, events
for an unrelated professional field.

Decision rule: does the event's own ACTIVITY (not who organizes or sponsors
it) build a technical skill, a resume line, or a career opportunity
specifically valuable to a CS/AI student? If the only tech connection is the
sponsor/organizer's identity and the activity itself isn't technical or
CS-career-relevant, mark "relevant": false.

Example: "Charity Run у Львові OBRIO × Chumaky × Молодвіж" -> relevant:
false (it's a sports event; a tech company sponsoring it doesn't make
running technical). Contrast: "AI/ML Hackathon Kyiv" -> relevant: true.

For every item with "relevant": true, also give a "relevanceScore" from 0
to 100 rating how strong the fit is (a vetoed/irrelevant item does not need
a meaningful score -- omit it or leave it low, it will not be used): 90-100
= flagship, highly specific fit (e.g. a national ML hackathon with real
prizes); 60-89 = clearly relevant but not top-tier; 30-59 = tangentially
relevant, weaker CS/AI connection.

Respond with ONLY a JSON array, no markdown fences, no commentary, in this exact shape:
[{"id": "<id>", "summary": "<one sentence>", "relevant": true, "relevanceScore": <0-100>, "reason": "<short reason>"}]

Items:
${JSON.stringify(items, null, 2)}`;
}

function extractJsonText(candidateText) {
  // Models sometimes wrap JSON in ```json fences despite instructions not to.
  const fenced = candidateText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : candidateText;
}

/**
 * Asks Gemini (via Vertex AI, OAuth2/ADC auth) for a one-sentence,
 * concrete-benefit summary of each opportunity, plus a relevance verdict,
 * in a single batched call. Returns a Map from opportunity id to
 * { summary, relevant, relevanceScore, reason } -- only for ids the model
 * actually returned. Per-item, a missing/non-boolean "relevant" defaults to
 * true and a missing/non-finite "relevanceScore" defaults to null
 * (fail-open: never silently veto something the model didn't clearly
 * reject, and never fabricate a score it didn't actually give). Throws on
 * any call-level failure (auth, network, non-2xx, unparseable JSON);
 * callers decide how to degrade (see attachSummaries).
 */
export async function summarizeOpportunities(
  opportunities,
  {
    project = process.env.GOOGLE_CLOUD_PROJECT,
    location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    model = process.env.GEMINI_MODEL,
    fetchImpl = fetch,
    getAccessToken = defaultGetAccessToken,
    // Called once per successful call with { promptTokens, candidatesTokens,
    // totalTokens, model } from the response's usageMetadata -- lets a
    // caller (see pipeline.js/lib/llm-usage.js) track spend without this
    // module needing to know anything about persistence or cost.
    onUsage = () => {},
  } = {},
) {
  if (opportunities.length === 0) return new Map();
  if (!project || !model) throw new Error('GOOGLE_CLOUD_PROJECT/GEMINI_MODEL is not set');

  const token = await getAccessToken();

  const response = await fetchImpl(vertexUrl({ project, location, model }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(opportunities) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Vertex AI error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();

  if (data.usageMetadata) {
    await onUsage({
      model,
      promptTokens: data.usageMetadata.promptTokenCount || 0,
      candidatesTokens: data.usageMetadata.candidatesTokenCount || 0,
      totalTokens: data.usageMetadata.totalTokenCount || 0,
    });
  }

  const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) throw new Error('Vertex AI response had no text content');

  const parsed = JSON.parse(extractJsonText(candidateText));
  if (!Array.isArray(parsed)) throw new Error('Vertex AI response JSON was not an array');

  const summaries = new Map();
  for (const item of parsed) {
    if (!item?.id || !item?.summary) continue;
    const relevant = typeof item.relevant === 'boolean' ? item.relevant : true;
    const relevanceScore = Number.isFinite(item.relevanceScore) ? item.relevanceScore : null;
    summaries.set(item.id, { summary: item.summary, relevant, relevanceScore, reason: item.reason || null });
  }
  return summaries;
}

/**
 * Attaches `.summary`, `.relevant`, `.relevanceScore`, `.relevanceReason` to
 * each opportunity. On any call-level failure, every opportunity fail-opens
 * to `.summary = null, .relevant = true, .relevanceScore = null,
 * .relevanceReason = null` -- an outage must never silently veto or blank
 * out a real opportunity, matching the house convention that a failed
 * summary should be absent, not replaced with recycled promotional filler
 * (see digest.js treating a null summary as "show nothing"). Never throws.
 * `onFailure(error)`, if given, lets a caller (see pipeline.js) surface this
 * into its own run-level issue reporting -- this function only logs to the
 * console on its own.
 */
export async function attachSummaries(opportunities, options, onFailure) {
  if (opportunities.length === 0) return [];

  const fallback = { summary: null, relevant: true, relevanceScore: null, relevanceReason: null };

  try {
    const results = await summarizeOpportunities(opportunities, options);
    return opportunities.map((o) => {
      const result = results.get(o.id);
      if (!result) return { ...o, ...fallback };
      return {
        ...o,
        summary: result.summary,
        relevant: result.relevant,
        relevanceScore: result.relevanceScore,
        relevanceReason: result.reason,
      };
    });
  } catch (error) {
    console.error('[summarize] Vertex AI call failed, leaving summaries blank:', error.message);
    if (onFailure) onFailure(error);
    return opportunities.map((o) => ({ ...o, ...fallback }));
  }
}
