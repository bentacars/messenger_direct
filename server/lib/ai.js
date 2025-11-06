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

// server/lib/ai.js  — replace ONLY this function
export async function jsonExtract({ system, input, schemaName }) {
  // define the properties once (keep key names aligned with qualifier.js)
  const props = {
    payment:      { type: "string",  description: "cash or financing if stated" },
    budget:       { type: "number",  description: "digits only, no commas" },
    location:     { type: "string",  description: "city/province if stated" },
    transmission: { type: "string",  description: "automatic|manual|any if stated" },
    bodyType:     { type: "string",  description: "sedan|suv|mpv|van|pickup|crossover|hatchback|auv etc." },
    brand:        { type: "string" },
    model:        { type: "string" },
    variant:      { type: "string" },
    year:         { type: "string" }
  };

  const schema = {
    name: schemaName || "extract",
    strict: true,
    schema: {
      type: "object",
      properties: props,
      required: Object.keys(props),        // <-- important
      additionalProperties: false          // <-- important
    }
  };

  const rsp = await client.chat.completions.create({
    model: MODELS.extractor,
    messages: [
      { role: "system", content: system || "Extract only what is explicitly stated. Do not guess." },
      { role: "user", content: input }
    ],
    temperature: 0.1,
    response_format: { type: "json_schema", json_schema: schema }
  });

  try {
    return JSON.parse(rsp.choices?.[0]?.message?.content || "{}");
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
