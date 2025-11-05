// LLM tone helper with lazy import + graceful fallback

const TRY_MODELS = [
  process.env.NLG_MODEL,
  "gpt-4o-mini",
  "gpt-4.1-mini"
].filter(Boolean);

const TEMP = Number(process.env.TEMP_TONE ?? 0.9);
const PRES = Number(process.env.PRES_PENALTY_TONE ?? 0.3);
const FREQ = Number(process.env.FREQ_PENALTY_TONE ?? 0.2);
const DEBUG = ["1", "true", "yes"].includes(String(process.env.DEBUG_LLM || "").toLowerCase());

function systemPrompt() {
  return [
    "Persona: Warm, friendly PH car consultant. Taglish. Maikli lang, human, relatable.",
    "Goal: Collect the SINGLE missing qualifier (payment, budget, location, transmission, body_type).",
    "Rules: Never repeat questions already answered. Recognize slang (hulog/hulugan=financing).",
    "If user gives brand/model/year/variant, note it as preference; do not interrogate it.",
    "Keep it conversational (no checklist tone). One or two sentences max."
  ].join("\n");
}

let _clientPromise = null;
async function getClient() {
  if (_clientPromise) return _clientPromise;

  if (String(process.env.ENABLE_TONE_LLM).toLowerCase() !== "true") {
    _clientPromise = Promise.resolve(null);
    return _clientPromise;
  }
  try {
    const { default: OpenAI } = await import("openai");
    const key = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
    if (!key) {
      console.warn("[ai] OPENAI_API_KEY missing; fallback to static tone.");
      _clientPromise = Promise.resolve(null);
      return _clientPromise;
    }
    const client = new OpenAI({ apiKey: key });
    _clientPromise = Promise.resolve(client);
    return client;
  } catch (err) {
    console.warn("[ai] openai package not installed; fallback to static tone.", err?.message || err);
    _clientPromise = Promise.resolve(null);
    return _clientPromise;
  }
}

export async function nlgLine(context, fallback) {
  const client = await getClient();
  if (!client) return fallback || "Sige, noted.";

  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: String(context || "") }
  ];

  let lastErr;
  for (const model of TRY_MODELS) {
    try {
      const resp = await client.chat.completions.create({
        model,
        temperature: isFinite(TEMP) ? TEMP : 0.9,
        presence_penalty: isFinite(PRES) ? PRES : 0.3,
        frequency_penalty: isFinite(FREQ) ? FREQ : 0.2,
        messages
      });
      const out = resp.choices?.[0]?.message?.content?.trim();
      if (DEBUG) console.log("[ai] model:", model, "→", out);
      if (out) return out;
    } catch (e) {
      lastErr = e;
      if (DEBUG) console.log("[ai] error:", model, e?.response?.data || e?.message);
    }
  }
  return fallback || "Got it.";
}

export default { nlgLine };
