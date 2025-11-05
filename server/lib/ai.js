// /server/lib/ai.js
// LLM-powered phrasing with graceful fallbacks

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPNEAI_API_KEY || process.env.OPENAI_KEY || ""
});

// Preferred → safe fallbacks
const TRY_MODELS = [
  process.env.NLG_MODEL,
  "gpt-4o-mini",
  "gpt-4.1-mini"
].filter(Boolean);

const TEMP = Number(process.env.TEMP_TONE ?? 0.9);
const PRES = Number(process.env.PRES_PENALTY_TONE ?? 0.3);
const FREQ = Number(process.env.FREQ_PENALTY_TONE ?? 0.2);

function systemPrompt(persona = "ph-car-consultant") {
  return [
    "Persona: Warm, friendly PH car consultant. Taglish. Keep it short, human, helpful.",
    "Style: Never robotic. Mirror user wording. Add light empathy. Avoid sounding like a form.",
    "Rules: Ask only the SINGLE missing qualifier. Never repeat a question already answered.",
    "You are assisting Phase 1 (qualifiers): payment (cash/financing), budget, location, transmission, body type.",
    "If user gives brand/model/year/variant, note it as preference but don't interrogate.",
    "No long lists; one natural sentence or two per turn."
  ].join("\n");
}

export async function nlgLine(context, hint) {
  if (String(process.env.ENABLE_TONE_LLM).toLowerCase() !== "true") {
    // Fallback fixed lines when LLM disabled
    return hint || "Sige, noted.";
  }

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
        messages,
      });
      return resp.choices?.[0]?.message?.content?.trim() || hint || "Got it.";
    } catch (e) {
      lastErr = e;
    }
  }
  // If models fail, do not break the chat
  console.warn("[ai] OpenAI error", lastErr?.response?.data || lastErr?.message || lastErr);
  return hint || "Got it.";
}

export default { nlgLine };
