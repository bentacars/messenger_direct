// server/lib/ai.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Centralized model choices (kept compatible with your envs)
export const MODELS = {
  default: process.env.MODEL_DEFAULT || "gpt-4.1-mini",
  tone: process.env.MODEL_TONE || "gpt-4o-mini",
  nlg: process.env.NLG_MODEL || process.env.MODEL_TONE || "gpt-4o-mini",
  extractor: process.env.EXTRACTOR_MODEL || "gpt-4o-mini",
};

/**
 * Basic text completion helper.
 * Usage:
 *   await complete({ system: "...", messages: [{role:"user", content:"..."}] })
 */
export async function complete({
  system,
  messages,
  model = MODELS.default,
  temperature = 0.3,
  max_tokens = 300,
}) {
  const arr = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...(Array.isArray(messages) ? messages : []),
  ];
  const rsp = await client.chat.completions.create({
    model,
    messages: arr,
    temperature,
    max_tokens,
  });
  return rsp.choices?.[0]?.message?.content?.trim() || "";
}

/**
 * JSON extractor using OpenAI json_schema format (strict).
 * IMPORTANT: Root must include additionalProperties: false.
 * Also align keys to your qualifier pipeline (bodyType, not 'body').
 */
export async function jsonExtract({
  system = "Extract only what is explicitly stated. Do not guess.",
  input = "",
  schemaName = "extract",
  // Allow override, but provide safe defaults that match the rest of the app.
  properties = {
    payment: { type: "string", description: "cash or financing if stated" },
    budget: { type: "string", description: "digits only, no commas" },
    location: { type: "string", description: "city/province if stated" },
    transmission: { type: "string", description: "automatic|manual|any if stated" },
    bodyType: { type: "string", description: "sedan|suv|mpv|van|pickup|hatchback|crossover|auv etc." },
    brand: { type: "string" },
    model: { type: "string" },
    variant: { type: "string" },
    year: { type: "string" },
  },
}) {
  const schema = {
    name: schemaName,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false, // <-- REQUIRED by the API
      properties,
    },
  };

  const rsp = await client.chat.completions.create({
    model: MODELS.extractor,
    messages: [
      { role: "system", content: system },
      { role: "user", content: input },
    ],
    temperature: 0.1,
    response_format: { type: "json_schema", json_schema: schema },
  });

  try {
    const txt = rsp.choices?.[0]?.message?.content || "{}";
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

/**
 * Back-compat shim used across your flows. Supports:
 *  - Plain text (default)
 *  - JSON extraction when opts.json === true
 *
 * Usage:
 *   await askLLM("prompt text");
 *   await askLLM("extract something", { json: true });
 */
export async function askLLM(prompt, opts = {}) {
  const {
    json = false,
    temperature = 0.7,
    model = MODELS.default,
    system = "You are a helpful, human-like Taglish sales assistant for BentaCars.",
    jsonSchemaName = "extract",
    jsonProperties, // optional override for extractor properties
  } = opts;

  if (!json) {
    // Text mode
    return await complete({
      system,
      messages: [{ role: "user", content: prompt }],
      model,
      temperature,
      max_tokens: 350,
    });
  }

  // JSON mode
  try {
    return await jsonExtract({
      system: "Extract only stated fields. Return valid JSON per schema.",
      input: prompt,
      schemaName: jsonSchemaName,
      properties: jsonProperties,
    });
  } catch (err) {
    console.error("[askLLM JSON error]", err);
    // propagate so callers can handle fallback
    throw err;
  }
}
