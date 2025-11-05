// /server/lib/ai.js
// LLM helpers: (1) slot extractor (strict JSON) (2) natural question generator

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_MESSENGER || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || 'gpt-5.1-mini';
const NLG_MODEL = process.env.NLG_MODEL || 'gpt-5.1';

if (!OPENAI_API_KEY) {
  console.warn('[ai] Missing OPENAI_API_KEY');
}

async function openaiChat({ model, temperature, messages, response_format }) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, temperature, messages, response_format })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${t}`);
  }
  const j = await res.json();
  const msg = j?.choices?.[0]?.message?.content ?? '';
  return msg;
}

/* -------------------- 1) Slot Extractor (strict JSON) -------------------- */
const EXTRACTOR_SYS = `
You extract car-buying qualifiers from short, noisy Taglish messages.
Return ONLY valid JSON matching this schema:

{
  "payment": "cash | financing | null",
  "budget": "number | null",
  "budget_is_upper": "boolean",
  "location": "string | null",
  "transmission": "automatic | manual | any | null",
  "bodyType": "sedan | suv | mpv | van | pickup | hatchback | crossover | any | null",
  "brand": "string | null",
  "model": "string | null",
  "variant": "string | null",
  "year": "string | null"
}

Mapping rules:
- "hulugan", "installment", "loan", "utang" => financing
- "spot cash", "straight", "cash basis" => cash
- AT/auto => automatic; MT => manual; "kahit ano" => any
- If a phrase implies "any", set bodyType/transmission to "any".
- Normalize "QC" to "Quezon City".
- Budget: strip ₱ and commas; if "below X"/"under X" set budget=X and budget_is_upper=true; if range like "500-600k" use midpoint.
- Prefer model/variant if the user mentions them even while other slots are missing.

Output JSON only, no commentary.
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

/* -------------------- 2) NLG — ask one friendly question -------------------- */
const NLG_SYS = `
You write one short, human question in Taglish to collect ONE missing qualifier.
Tone: friendly, concise, casual PH sales agent; no checklist vibe; avoid repeating exact wording twice in a row.
If a first_name is provided, address them by name and DO NOT use "sir/ma’am".
If first_name is absent, you may optionally add a light honorific (sir/ma’am/boss) at most 1 in 3 times.

Context will include:
- known_fields = JSON of already captured qualifiers
- slot = one of: payment, budget, location, transmission, bodyType
- first_name = optional string

Guidance:
- Mention nationwide when asking location.
- Keep to one sentence, max ~20 words.
- Ask ONLY about {{slot}}.
- No bullet points. No emojis unless the user used one.

Return plain text only.
`.trim();

export async function nlgAskForSlot(slot, knownFields, firstName = '', avoidLine = '') {
  const user = [
    `known_fields=${JSON.stringify(knownFields || {})}`,
    `slot=${slot}`,
    `first_name=${firstName || ''}`,
    avoidLine ? `avoid="${avoidLine}"` : ''
  ].join('\n');

  try {
    const text = await openaiChat({
      model: NLG_MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: NLG_SYS },
        { role: 'user', content: user }
      ]
    });
    return (text || '').trim();
  } catch (e) {
    console.warn('[ai.nlg] fail:', e?.message || e);
    // safe fallback phrasing per slot
    const f = {
      payment: 'Pwede cash or hulugan. Ano mas prefer mo?',
      budget: 'Para hindi ako lumampas, mga magkano budget mo?',
      location: 'Nationwide tayo — anong city/province mo para malapit ang options?',
      transmission: 'Automatic, manual, or ok lang kahit alin?',
      bodyType: '5-seater or 7+ seater? Or van/pickup ok din?'
    };
    return f[slot] || 'Sige, tell me more?';
  }
}

export default { extractSlotsLLM, nlgAskForSlot };
