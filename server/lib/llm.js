// server/lib/llm.js
// LLM utils: tone, unit hooks, FAQ fallback answers.

import OpenAI from "openai";
import { OPENAI_MODEL } from "./constants.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function aiHookForUnit(unit) {
  const prompt = `
  Give me 1 short Taglish selling hook for this used car:
  Brand: ${unit.brand}
  Model: ${unit.model}
  Variant: ${unit.variant}
  Body type: ${unit.body_type}
  Transmission: ${unit.transmission}
  
  ✅ Use soft facts only (matipid, spacious, good for family, easy parts).
  ✅ Max 12 words.
  ✅ Friendly and natural (no hype, no emojis).
  ✅ If unsure, use body-type fallback.
  `;
  const res = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });
  return res.choices[0].message?.content?.trim() || "";
}

export async function aiShortAnswer({ question, context }) {
  const prompt = `
  The user asked: "${question}"
  You are a friendly PH auto consultant.
  Reply in 1–2 short Taglish lines.
  IF the question is unrelated to cars, reply nicely and shift back to the flow.

  Context: ${JSON.stringify(context)}
  `;
  const res = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });
  return res.choices[0].message?.content?.trim() || null;
}
