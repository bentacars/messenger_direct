// /server/lib/ai.js
// LLM helpers: (1) strict JSON slot extractor  (2) natural, one-line question generator

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

// Prefer your cheaper model envs if present; fall back safely.
const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || process.env.MODEL_DEFAULT || 'gpt-4o-mini';
const NLG_MODEL       = process.env.NLG_MODEL       || process.env.MODEL_TONE   || 'gpt-4o-mini';

const TEMP_TONE = Number(process.env.TEMP_TONE ?? 0.75);
const FREQ_PENALTY_TONE = Number(process.env.FREQ_PENALTY_TONE ?? 0.2);

// Turn this on in Vercel to *visibly* mark LLM vs fallback in chat.
const DEBUG_LLM = String(process.env.DEBUG_LLM || '0') === '1';

async function openaiChat({ model, temperature, messages, response_format, frequency_penalty }) {
  if (!OPENAI_API_KEY) {
    console.warn('[ai] OPENAI_API_KEY missing');
    throw new Error('OPENAI_API_KEY missing');
  }
  const body = { model, temperature, messages, response_format, frequency_penalty };
  if (DEBUG_LLM) console.log('[ai] chat', { model, temperature, hasRF: !!response_format });

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.warn('[ai] OpenAI error', res.status, t);
    throw new Error(`OpenAI ${res.status}`);
  }
  const j = await res.json();
  const out = j?.choices?.[0]?.message?.content ?? '';
  if (DEBUG_LLM) console.log('[ai] reply', out);
  return out;
}

/* ---------------- 1) Slot Extractor (strict JSON) ---------------- */
const EXTRACTOR_SYS = `
You extract car-buying qualifiers from short, noisy Taglish messages.
Return ONLY valid JSON with keys:
payment (cash|financing|null), budget (number|null), budget_is_upper (boolean),
location (string|null), transmission (automatic|manual|any|null),
bodyType (sedan|suv|mpv|van|pickup|hatchback|crossover|any|null),
brand (string|null), model (string|null), variant (string|null), year (string|null).

Mapping: hulugan/installment/loan/utang => financing; spot cash/straight/cash basis => cash.
AT/auto => automatic; MT => manual; “kahit ano” => any. "QC" => "Quezon City".
Budget: strip ₱ and commas; "below/under X" => budget=X, budget_is_upper=true;
range "500-600k" => midpoint.
Output JSON only.
`.trim();

export async function extractSlotsLLM(userText) {
  if (!userText) return null;
  const messages = [
    { role: 'system', content: EXTRACTOR_SYS },
    { role: 'user', content: String(userText) }
  ];
  try {
    const raw = await openaiChat({
      model: EXTRACTOR_MODEL,
      temperature: 0,
      messages,
      response_format: { type: 'json_object' }
    });
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[ai.extractor] fail:', e?.message || e);
    return null;
  }
}

/* ---------------- 2) NLG: one friendly question ---------------- */
const NLG_SYS = `
You write ONE short, human question in Taglish to collect ONE missing qualifier.
Tone: warm, friendly PH sales agent; no checklist vibe; concise; avoid repeating the exact same wording as the previous line.
If first_name is provided, greet by name and do NOT use sir/ma'am. Otherwise, light honorific is allowed but not required.

Context:
- known_fields = JSON of captured qualifiers
- slot = payment|budget|location|transmission|bodyType
- first_name = optional
- avoid = the last exact line we asked (do not repeat it)

Guidance:
- When asking location, mention that inventory is nationwide.
- One sentence (<=20 words). No bullets. No emojis unless the user used one.

Return plain text only.
`.trim();

export async function nlgAskForSlot(slot, knownFields, firstName = '', avoidLine = '') {
  const user = [
    `known_fields=${JSON.stringify(knownFields || {})}`,
    `slot=${slot}`,
    `first_name=${firstName || ''}`,
    `avoid=${avoidLine || ''}`
  ].join('\n');

  try {
    const text = await openaiChat({
      model: NLG_MODEL,
      temperature: TEMP_TONE,
      frequency_penalty: FREQ_PENALTY_TONE,
      messages: [
        { role: 'system', content: NLG_SYS },
        { role: 'user', content: user }
      ]
    });
    return (text || '').trim();
  } catch (e) {
    console.warn('[ai.nlg] fail:', e?.message || e);
    const f = {
      payment: 'Pwede cash or hulugan. Ano mas prefer mo?',
      budget: 'Para hindi ako lumampas, mga magkano budget mo?',
      location: 'Nationwide tayo—saan ka based para mahanap ko yung pinakamalapit?',
      transmission: 'Automatic, manual, or ok lang kahit alin?',
      bodyType: '5-seater or 7+ seater? Or van/pickup ok din?'
    };
    return f[slot] || 'Sige, tell me more?';
  }
}

export default { extractSlotsLLM, nlgAskForSlot };
