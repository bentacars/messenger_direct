// /server/lib/ai.js
// Small AI helper for natural-language tone (optional).
// If ENABLE_TONE_LLM=false or the OpenAI SDK/key isn't present, it just returns your original text.

let _clientPromise = null;

async function getClient() {
  if (_clientPromise) return _clientPromise;

  const enabled = String(process.env.ENABLE_TONE_LLM || "").toLowerCase() === "true";
  if (!enabled) {
    _clientPromise = Promise.resolve(null);
    return _clientPromise;
  }

  try {
    // Dynamic import so your app doesn't crash if package isn't installed yet
    const { default: OpenAI } = await import("openai");
    const key = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
    if (!key) {
      console.warn("[ai] OPENAI_API_KEY missing; tone disabled");
      _clientPromise = Promise.resolve(null);
      return _clientPromise;
    }
    const client = new OpenAI({ apiKey: key });
    _clientPromise = Promise.resolve(client);
    return client;
  } catch (err) {
    console.warn("[ai] openai package not installed; tone disabled ->", err?.message || err);
    _clientPromise = Promise.resolve(null);
    return _clientPromise;
  }
}

export async function nlg(rawText, { persona = "friendly", locale = "taglish" } = {}) {
  const client = await getClient();
  if (!client) return rawText;

  const model =
    process.env.NLG_MODEL ||
    process.env.MODEL_TONE ||
    process.env.MODEL_DEFAULT ||
    "gpt-4o-mini";

  const temp =
    Number(process.env.TEMP_TONE ?? process.env.TEMP_DEFAULT ?? 0.8);

  const freqPenalty =
    Number(process.env.FREQ_PENALTY_TONE ?? 0.1);

  const sys = [
    `You rewrite short chat messages for a Philippine car-sales assistant.`,
    `Goal: sound human, approachable, natural—not robotic.`,
    `Keep content, intent and length similar; just smoothen tone.`,
    `Use Taglish (Filipino + English) appropriate for messenger.`,
    `Avoid being overly flowery; keep it crisp and conversational.`,
  ].join(" ");

  try {
    const res = await client.chat.completions.create({
      model,
      temperature: temp,
      frequency_penalty: freqPenalty,
      messages: [
        { role: "system", content: `${sys} Persona: ${persona}. Locale: ${locale}.` },
        { role: "user", content: rawText }
      ]
    });
    const out = res.choices?.[0]?.message?.content?.trim();
    return out || rawText;
  } catch (err) {
    console.warn("[ai.nlg] error ->", err?.message || err);
    return rawText;
  }
}
