// Generates ONE short Taglish soft-selling line per unit (no hard specs).
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
const MODEL = process.env.MODEL_DEFAULT || 'gpt-4.1-mini';
const TEMP  = Number(process.env.TEMP_DEFAULT ?? 0.4);

// Safety: if no key, just return empty string so flow continues.
const hasKey = !!OPENAI_KEY;

export async function softHookFor(unit){
  if (!hasKey) return ''; // fail-safe

  const { brand='', model='', variant='', body_type='' } = unit || {};
  const sys = 'You are a friendly Filipino car consultant. Reply in Taglish, one short line (max 12 words), no emojis.';
  const usr = `
Give ONE short Taglish selling hook (max 12 words).
Avoid hard specs (hp/torque/dimensions); focus on soft benefits (tipid, practical, comfy, family-ready, dependable, etc.).
Do NOT repeat the price, monthly, or "all-in".
No emojis. Sound human and credible, not pushy.

Data:
brand: ${brand}
model: ${model}
variant: ${variant}
body_type: ${body_type}
`;

  try{
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: TEMP,
        messages:[
          { role:'system', content: sys },
          { role:'user', content: usr }
        ]
      })
    });
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content?.trim() || '';
    // keep it within one line
    return text.replace(/\s+/g,' ').slice(0, 140);
  }catch(e){
    // On any API error, just skip the hook so UX continues smoothly
    return '';
  }
}
