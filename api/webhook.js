import fetch from 'node-fetch';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/* ========= Config (env-driven) ========= */
const OPENAI_URL   = 'https://api.openai.com/v1/chat/completions';
const MODEL        = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMPERATURE  = Number(process.env.TEMP_DEFAULT ?? 0.30);
const MAX_TURNS    = 18; // memory depth
const INVENTORY_ENDPOINT = process.env.INVENTORY_ENDPOINT; // Apps Script /exec URL

// Phase 1 stop line (exact match)
const STOP_LINE = 'GOT IT! ✅ I now have everything I need. I can now search available units for you.';

// Load the qualifier system prompt from file
const QUALIFIER_PROMPT = await readFile(
  path.join(process.cwd(), 'prompts', 'qualifier.txt'),
  'utf8'
);

/* ========= In-memory session store (OK for now) ========= */
const sessions = new Map();
function historyFor(senderId) {
  if (!sessions.has(senderId)) {
    sessions.set(senderId, [
      { role: 'system', content: QUALIFIER_PROMPT }
    ]);
  }
  return sessions.get(senderId);
}
function clampHistory(arr) {
  const systemMsg = arr[0];
  const tail = arr.slice(-MAX_TURNS * 2);
  return [systemMsg, ...tail];
}

/* ========= OpenAI + Messenger helpers ========= */
async function sendToOpenAI(history) {
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: history,
      temperature: TEMPERATURE
    })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error('OpenAI error:', resp.status, json);
    throw new Error('OpenAI request failed');
  }
  return json?.choices?.[0]?.message?.content?.trim() || '';
}

async function sendToMessenger(psid, text) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.FB_PAGE_TOKEN}`;
  const body = {
    messaging_type: 'RESPONSE',
    recipient: { id: psid },
    message: { text }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const msg = await r.text();
    console.error('Messenger Send API error:', r.status, msg);
  }
}

/* ========= Phase-2: Inventory matching (Apps Script JSON) ========= */
async function fetchInventoryFromAppsScript() {
  if (!INVENTORY_ENDPOINT) throw new Error('INVENTORY_ENDPOINT not set');
  const r = await fetch(INVENTORY_ENDPOINT, { method: 'GET' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Inventory fetch failed: ${r.status}`);
  return Array.isArray(j.items) ? j.items : [];
}

/* Extract rough buyer wants from the chat history (lite) */
function extractWants(history) {
  const text = history.map(m => m.content).join(' ').toLowerCase();

  const want = {
    payment: /financ/i.test(text) ? 'financing' : (/cash/i.test(text) ? 'cash' : null),
    cash_budget_min: null, cash_budget_max: null,
    dp_min: null, dp_max: null,
    city: null, province: null,
    preferred_type_or_model: null
  };

  // cash budget range like "400k-500k"
  const range = text.match(/(\d[\d,\.]*)\s*[-–]\s*(\d[\d,\.]*)/);
  if (range && want.payment === 'cash') {
    const a = Number(range[1].replace(/[^\d]/g,'')); 
    const b = Number(range[2].replace(/[^\d]/g,''));
    want.cash_budget_min = Math.min(a,b); 
    want.cash_budget_max = Math.max(a,b);
  } else if (want.payment === 'cash') {
    const single = text.match(/(?:budget|cash)\D{0,8}(\d[\d,\.]*)/);
    if (single) {
      const v = Number(single[1].replace(/[^\d]/g,''));
      if (isFinite(v)) { want.cash_budget_min = v*0.9; want.cash_budget_max = v*1.1; }
    }
  }

  // financing DP like "80k dp"
  const dp = text.match(/(?:dp|down ?payment)[^\d]{0,8}(\d[\d,\.]*)/);
  if (dp && want.payment === 'financing') {
    const v = Number(dp[1].replace(/[^\d]/g,''));
    if (isFinite(v)) { want.dp_min = v*0.9; want.dp_max = v*1.1; }
  }

  // basic city/province detection (expand later)
  const cityHit = text.match(/\b(quezon city|qc|manila|makati|pasig|pasay|taguig|mandaluyong|marikina|caloocan|antipolo|cebu|davao|cavite)\b/);
  if (cityHit) want.city = cityHit[0];

  // body type or model keywords
  const typeHit = text.match(/\b(suv|sedan|mpv|hatchback|pickup|van|vios|fortuner|innova|terra|xpander|stargazer|l300)\b/);
  if (typeHit) want.preferred_type_or_model = typeHit[0];

  return want;
}

/* Score + sort matches */
function rankMatches(rows, want) {
  const n = s => (s ?? '').toString().trim().toLowerCase();
  const num = v => {
    const x = Number(String(v).replace(/[₱,]/g,'').trim());
    return isFinite(x) ? x : null;
  };

  return rows.map(r => {
    const city = n(r.city);
    const prov = n(r.province);
    const body = n(r.body_type);
    const brand = n(r.brand);
    const model = n(r.model);
    const variant = n(r.variant);
    const price = num(r.srp ?? r.price);
    const dp = num(r.dp); // only if your JSON has a dp column; otherwise ignored

    let score = 0;

    // Budget fit
    if (want.payment === 'cash' && price != null) {
      if (want.cash_budget_min != null && want.cash_budget_max != null) {
        if (price >= want.cash_budget_min && price <= want.cash_budget_max) score += 60;
        else if (price >= want.cash_budget_min*0.9 && price <= want.cash_budget_max*1.1) score += 40;
      }
    }
    if (want.payment === 'financing' && dp != null) {
      if (want.dp_min != null && want.dp_max != null) {
        if (dp >= want.dp_min && dp <= want.dp_max) score += 60;
        else if (dp >= want.dp_min*0.9 && dp <= want.dp_max*1.1) score += 40;
      }
    }

    // Location
    if (want.city && city && city === n(want.city)) score += 20;
    else if (want.province && prov && prov === n(want.province)) score += 12;

    // Preference (type/model)
    const blob = [brand, model, variant, body].join(' ');
    if (want.preferred_type_or_model && blob.includes(n(want.preferred_type_or_model))) score += 15;
    else if (want.preferred_type_or_model && body.includes(n(want.preferred_type_or_model))) score += 10;

    // Newer year tiny bump
    const yr = Number(r.year) || 0;
    score += Math.min(Math.max(yr - 2000, 0), 5) * 0.5;

    return { score, row: r };
  })
  .sort((a,b) => b.score - a.score)
  .map(x => x.row);
}

/* Compact text output (don’t expose internal fields) */
function formatMatches(rows, limit = 3) {
  const pick = rows.slice(0, limit);
  if (!pick.length) return 'Walang exact match. Okay ba i-expand ng konti ang budget or nearby cities para may maipakita ako?';

  return pick.map(r => {
    const brand = r.brand || '';
    const model = r.model || '';
    const variant = r.variant || '';
    const year = r.year || '';
    const price = r.srp ?? r.price ?? '';
    const city = r.city || '';
    const mileage = r.mileage ? `${r.mileage} km` : '';
    return `• ${brand} ${model} ${variant} ${year} — ₱${price} — ${city}${mileage ? ' — ' + mileage : ''}`;
  }).join('\n');
}

/* ========= Webhook handler ========= */
export default async function handler(req, res) {
  // Verification (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // Messages (POST)
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (body.object !== 'page') return res.status(404).send('Not a page subscription');

      for (const entry of body.entry || []) {
        for (const event of entry.messaging || []) {
          const psid = event?.sender?.id;
          if (!psid) continue;

          const text =
            event?.message?.text ||
            event?.postback?.title ||
            '';
          if (!text) continue;

          // Update convo
          const hist = historyFor(psid);
          hist.push({ role: 'user', content: text });

          // Ask OpenAI
          const reply = await sendToOpenAI(hist);
          if (!reply) continue;

          // Save AI reply + clamp
          hist.push({ role: 'assistant', content: reply });
          sessions.set(psid, clampHistory(hist));

          // Send back to Messenger
          await sendToMessenger(psid, reply);

          // If Phase-1 complete, run matching and send short list
          if (reply.includes(STOP_LINE)) {
            try {
              const wants = extractWants(hist);
              const all = await fetchInventoryFromAppsScript();
              const ranked = rankMatches(all, wants);
              const list = formatMatches(ranked, 3);
              const intro = 'Ito yung best na swak sa budget/location mo para di ka na mag-scroll:';
              await sendToMessenger(psid, `${intro}\n${list}`);
            } catch (e) {
              console.error('Matching error:', e);
              await sendToMessenger(psid, 'Nagkaproblema sa paghanap ng units. Subukan natin ulit mamaya or i-tweak natin criteria.');
            }
          }
        }
      }
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(500).send('Server error');
    }
  }

  return res.status(405).send('Method Not Allowed');
}

export const config = { api: { bodyParser: true } };
