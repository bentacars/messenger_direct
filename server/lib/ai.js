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

// === LLM-FIRST HELPERS (add at end of server/lib/ai.js) ===

/**
 * Forgiving JSON-schema extract.
 * - No "required" list
 * - additionalProperties: false
 * - Only returns keys the model is confident about
 */
export async function jsonSchemaExtractLoose({ system, input, schemaName = "extract", properties }) {
  const schema = {
    name: schemaName,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties
    }
  };

  const rsp = await client.chat.completions.create({
    model: MODELS.extractor,
    messages: [
      { role: "system", content: system },
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

/** Extract user qualifiers in one shot (LLM-first + normalization hints) */
export async function llmExtractQualifiers(userText = "") {
  const system =
    "Extract only what the user explicitly stated. Normalize numbers (k/m) and common PH place spellings. " +
    "Return only keys you are confident about. Do not guess.";
  const properties = {
    payment:      { type: "string", description: "cash or financing if stated" },
    budget:       { type: "number", description: "PHP, digits only; accept 550k/1.2m/below 550k → 550000/1200000/550000" },
    location:     { type: "string", description: "City/Province; normalize misspellings e.g., 'Quezon City'" },
    transmission: { type: "string", description: "automatic | manual | any" },
    bodyType:     { type: "string", description: "sedan|suv|mpv|van|pickup|crossover|hatchback|auv" },
    brand:        { type: "string" },
    model:        { type: "string" },
    variant:      { type: "string" },
    year:         { type: "string" }
  };

  return await jsonSchemaExtractLoose({
    system,
    input: `User: ${userText}`,
    schemaName: "qualifiers",
    properties
  });
}

/**
 * Planner: decide the next best question (AAL style) and optional updates.
 * Returns: { updates: {...}, ask: "one short question", done: boolean }
 */
export async function llmPlanNext({ history = "", qualifier = {}, userText = "" } = {}) {
  const system =
    "You are a friendly Taglish car sales AI for BentaCars. " +
    "Goal: gather enough info to match units. Acknowledge briefly (A), ask ONE short missing question (A), " +
    "and avoid repeating what is already known (L). If info is sufficient, set done=true and keep ask short/optional.";

  const properties = {
    updates: {
      type: "object",
      additionalProperties: false,
      properties: {
        payment:      { type: "string" },
        budget:       { type: "number" },
        location:     { type: "string" },
        transmission: { type: "string" },
        bodyType:     { type: "string" },
        brand:        { type: "string" },
        model:        { type: "string" },
        variant:      { type: "string" },
        year:         { type: "string" }
      }
    },
    ask:  { type: "string", description: "ONE short, human, Taglish question for the most helpful missing field" },
    done: { type: "boolean" }
  };

  const input =
    `Known so far (qualifier JSON): ${JSON.stringify(qualifier)}\n` +
    `Latest user message: "${userText}"\n` +
    `Chat notes: ${history || "(none)"}\n` +
    `Ask only one thing if still missing; keep it short and conversational.`;

  return await jsonSchemaExtractLoose({
    system,
    input,
    schemaName: "plan",
    properties
  });
}
