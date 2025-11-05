// /server/lib/ai.js
// GPT-5 tone for Phase-1 questions + strict extractor

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || process.env.MODEL_DEFAULT || 'gpt-4o-mini';
const NLG_MODEL       = process.env.NLG_MODEL       || process.env.MODEL_TONE   || 'gpt-5.1-mini';

const TEMP_TONE = Number(process.env.TEMP_TONE ?? 0.9);
const FREQ_PENALTY_TONE = Number(process.env.FREQ_PENALTY_TONE ?? 0.1);
const PRES_PENALTY_TONE = Number(process.env.PRES_PENALTY_TONE ?? 0.3);
const DEBUG_LLM = String(process.env.DEBUG_LLM || '0') === '1';

async function openaiChat({ model, temperature, messages, response_format, frequency_penalty, presence_penalty }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  const body = { model, temperature, messages, response_format, frequency_penalty, presence_penalty };
  if (DEBUG_LLM) console.log('[ai] chat', { model, temperature });

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

/* ---------- 1) Extractor (strict JSON) ---------- */
const EXTRACTOR_SYS = `
Extract car-buying qualifiers from short Taglish. Return ONLY JSON keys:
payment(cash|financing|null), budget(number|null), budget_is_upper(boolean),
location(string|null), transmission(automatic|manual|any|null),
bodyType(sedan|suv|mpv|van|pickup|hatchback|crossover|any|null),
brand(string|null), model(string|null), variant(string|null), year(string|null).

Map: hulugan/installment/loan/utang=>financing; spot cash/straight=>cash;
AT/auto=>automatic; MT=>manual; "kahit ano"=>any; "QC"=>"Quezon City".
Budget: strip ₱/commas; "below/under X"=> budget=X & budget_is_upper=true;
"500-600k"=> midpoint. Output JSON only.
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

/* ---------- 2) NLG one-liner (GPT-5) ---------- */
const NLG_SYS = `
You write ONE short, natural Taglish question to collect ONE missing qualifier.
Persona: warm PH car consultant—helps, mirrors the user's words, never robotic.
Rules:
- If first_name exists, address them by name; never use sir/ma'am.
- Keep it one sentence, <= 18 words, no bullets.
- No emojis unless the user used one earlier.
- Vary phrasing from "avoid" exactly; do not repeat lines.
- When asking location, mention we match from a nationwide inventory.
Slots: payment | budget | location | transmission | bodyType.
Return plain text only.
`.trim();

export async function nlgAskForSlot(slot, knownFields, firstName = '', avoidLine = '') {
  const user = [
    `slot=${slot}`,
    `first_name=${firstName || ''}`,
    `avoid=${avoidLine || ''}`,
    `known_fields=${JSON.stringify(knownFields || {})}`
  ].join('\n');

  try {
    const text = await openaiChat({
      model: NLG_MODEL,
      temperature: TEMP_TONE,
      frequency_penalty: FREQ_PENALTY_TONE,
      presence_penalty: PRES_PENALTY_TONE,
      messages: [
        { role: 'system', content: NLG_SYS },
        { role: 'user', content: user }
      ]
    });
    return (text || '').trim();
  } catch (e) {
    console.warn('[ai.nlg] fail:', e?.message || e);
    const f = {
      payment: 'We can do cash or hulugan—alin ang mas okay sa’yo?',
      budget: 'Para hindi ako lumagpas, mga magkano ang target budget mo?',
      location: 'Nationwide tayo—saan ka nakabase para ma-match ko sa pinakamalapit?',
      transmission: 'Automatic ba gusto mo, manual, o puwedeng kahit alin?',
      bodyType: '5-seater or 7+ seater ang hanap mo? Van/pickup ok din kung gusto mo.'
    };
    return f[slot] || 'Sige, share mo pa para ma-match ko nang tama.';
  }
}

export default { extractSlotsLLM, nlgAskForSlot };
