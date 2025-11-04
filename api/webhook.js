// api/webhook.js
import { sendText, sendImage } from './lib/messenger.js';
import { matchTopTwo, parseInventoryItem, fetchInventory } from './lib/matching.js';

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const INVENTORY_URL = process.env.INVENTORY_API_URL;
const ENABLE_TONE = (process.env.ENABLE_TONE_LLM || '0') === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAT_API_KEY;
const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMP_DEFAULT = Number(process.env.TEMP_DEFAULT ?? 0.30);

// ---------- Optional tone rewriter (Taglish, friendly, expert) ----------
async function maybeHumanize(text) {
  if (!ENABLE_TONE || !OPENAI_API_KEY) return text;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_DEFAULT,
        temperature: TEMP_DEFAULT,
        messages: [
          {
            role: 'system',
            content:
              "You are a warm, human-sounding Filipino car sales consultant (Taglish). " +
              "Be short, friendly, and expert. Build light rapport but keep it efficient. " +
              "Avoid robotic phrasing and avoid emoji spam (0–1 emoji max). " +
              "No quick-reply buttons or lists—sound like a real person."
          },
          { role: 'user', content: text }
        ]
      })
    });
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || text).trim();
  } catch {
    return text;
  }
}
async function talk(psid, text) { await sendText(psid, await maybeHumanize(text)); }

// ---------- Minimal name sniff (safe if profile absent) ----------
function detectName(event) {
  try {
    const prof =
      event?.sender?.profile ||
      event?.message?.nlp?.entities?.profile?.[0] ||
      event?.context?.user_profile ||
      null;
    const full = prof?.name || prof?.first_name || null;
    if (!full) return null;
    const first = String(full).trim().split(/\s+/)[0];
    return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : null;
  } catch { return null; }
}

// ---------- Ephemeral in-memory session ----------
const SESSIONS = new Map();
const TTL_MS = (parseInt(process.env.MEMORY_TTL_DAYS || '7', 10)) * 24 * 60 * 60 * 1000;
const now = () => Date.now();
function getSession(psid) {
  const s = SESSIONS.get(psid);
  if (!s) return null;
  if (now() - s.updatedAt > TTL_MS) { SESSIONS.delete(psid); return null; }
  return s;
}
function ensureSession(psid) {
  const s = getSession(psid) || {
    phase: 'start',    // start -> plan -> location -> body -> trans -> budget -> ready
    plan: null,        // 'cash' | 'financing'
    location: null,
    body: null,        // sedan/suv/mpv/van/pickup/any
    trans: null,       // automatic/manual/any
    budget: null,      // text range
    modelHint: null,   // optional ("vios", etc.)
    offer: null,       // last offered 2 items
    name: null
  };
  s.updatedAt = now();
  SESSIONS.set(psid, s);
  return s;
}
function resetSession(psid) { SESSIONS.delete(psid); }

// ---------- Text helpers ----------
const normalize = (t = '') => t.trim().toLowerCase();
const isRestart = (t) => /^(restart|start over|reset|ulit tayo|bagong search|new inquiry)$/.test(normalize(t));
function parsePlan(t) { const s = normalize(t); if (/\bcash\b/.test(s)) return 'cash'; if (/financ/.test(s)) return 'financing'; return null; }
function parseBody(t) { const s = normalize(t); if (/\bsedan\b/.test(s)) return 'sedan'; if (/\bsuv\b/.test(s)) return 'suv'; if (/\bmpv\b/.test(s)) return 'mpv'; if (/\bvan\b/.test(s)) return 'van'; if (/\bpick(?: ?up)?\b/.test(s)) return 'pickup'; if (/\bany\b/.test(s)) return 'any'; return null; }
function parseTrans(t){ const s = normalize(t); if (/auto/.test(s)) return 'automatic'; if (/manu/.test(s)) return 'manual'; if (/\bany\b/.test(s)) return 'any'; return null; }
function parsePick(t) { const s = normalize(t); const m = s.match(/\b([12])\b/); return m ? parseInt(m[1], 10) : null; }
function validText(t) { return t && t.trim().length >= 2; }
function sniffModelHint(t = '') {
  const m = t.match(/\b(vios|mirage|city|accent|fortuner|innova|xtrail|civic|corolla|nv350|hiace|raize|br-v|livina|terra|urvan)\b/i);
  return m ? m[0] : null;
}
function prettyTitle(item) {
  const year = item.year ? String(item.year) : '';
  const brand = item.brand || '';
  const model = item.model || '';
  const variant = item.variant ? (' ' + item.variant) : '';
  return `${year} ${brand} ${model}${variant}`.trim();
}

// ---------- Copy (human-friendly) ----------
const COPY = {
  welcomeNew: (name) =>
    `Hi${name ? ' ' + name : ''}! 👋 I’m your BentaCars consultant. ` +
    `Tutulungan kitang ma-match sa best unit para hindi ka na endless scroll. ` +
    `Quick lang — cash payment ka ba or financing plan?`,
  welcomeBack: (snap) =>
    `Welcome back! 👋 Last time, noted ko ito: ${snap}. ` +
    `Gusto mo bang ituloy yan, or type **restart** para magsimula ulit?`,
  askPlan: `Para ma-match ka nang maayos, cash ba o financing ang plan mo? 🙂`,
  ackPlan: (p) => `Got it — ${p.toUpperCase()} ✅`,
  askLocation: `Saan ka base para madaling tingnan ang malapit na units? (city/province)`,
  ackLocation: (loc) => `Sige, ${loc}. Marami tayong ma-check diyan. ✅`,
  askBody: `Anong type ang gusto mo? Sedan, SUV, MPV, Van, Pickup — or **any** kung flexible ka.`,
  ackBody: (b) => `Copy — ${b} type. ✅`,
  askTrans: `Transmission? Automatic o Manual — pwede ring **any**.`,
  ackTrans: (t) => `Noted — ${t}. ✅`,
  askBudgetCash: `Last na: mga magkano ang **cash budget** mo? (hal. ₱450k–₱600k)`,
  askBudgetFin: `Last na: mga magkano ang **ready cash-out / all-in** range mo? (hal. 150k–220k)`,
  ackBudget: `Salamat! ✅ Sapat na yan para ma-filter ko nang ayos.`,
  searching: `Sige, i-scan ko na ang inventory para sa pinaka-swak na dalawa (priority muna kung meron).`,
  offerIntro: `Ito yung pinaka-swak sa details mo (Priority muna kung available):`,
  proceedNonPriority: `Walang Priority sa filter mo, kaya nag-proceed ako sa best matches na available.`,
  whichPick: `Alin ang mas gusto mo, #1 o #2? Pwede mo rin sabihin ang model name.`,
  galleryHint: `Gusto mo ng full photos? Sabihin mo: “more photos” o “full photos of #1/#2”.`,
  nothingFound: `Walang pasok sa sobrang higpit ng filter. Okay bang i-relax natin ng kaunti (budget o nearby cities) para may maipakita agad?`,
  afterPick: (title) => `Great choice! ${title}. Isesend ko ang full photos — then pwede na tayong mag-schedule ng viewing.`
};

// ---------- Public webhook ----------
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
      return res.status(403).send('Forbidden');
    }
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // Vercel usually gives req.body; if not, try json()
    let body = req.body;
    if (!body || (typeof body === 'string' && !body.length)) {
      try { body = await req.json(); } catch { body = null; }
    }
    if (!body || body.object !== 'page') return res.status(200).json({ ok: true });

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const psid = event?.sender?.id;
        if (!psid) continue;

        if (event.message?.text) {
          await onText(psid, event.message.text, event);
        } else if (event.postback?.payload) {
          await onText(psid, event.postback.payload, event);
        }
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
}

// ---------- Conversation engine ----------
async function onText(psid, rawText, event) {
  const text = rawText || '';
  const s = ensureSession(psid);
  if (!s.name) s.name = detectName(event) || null;

  // Restart
  if (isRestart(text)) {
    resetSession(psid);
    const ns = ensureSession(psid);
    await talk(psid, COPY.welcomeNew(s.name));
    ns.phase = 'plan';
    return;
  }

  // Model hint anytime
  const mh = sniffModelHint(text);
  if (mh) s.modelHint = mh;

  // Greet
  if (s.phase === 'start') {
    const snap = snapshotQual(s);
    if (snap) {
      await talk(psid, COPY.welcomeBack(snap));
    } else {
      await talk(psid, COPY.welcomeNew(s.name));
      s.phase = 'plan';
    }
    return;
  }

  // FSM
  switch (s.phase) {
    case 'plan': {
      const plan = parsePlan(text);
      if (!plan) { await talk(psid, COPY.askPlan); return; }
      s.plan = plan;
      await talk(psid, COPY.ackPlan(plan));
      await talk(psid, COPY.askLocation);
      s.phase = 'location';
      return;
    }
    case 'location': {
      if (!validText(text)) { await talk(psid, COPY.askLocation); return; }
      s.location = text.trim();
      await talk(psid, COPY.ackLocation(s.location));
      await talk(psid, COPY.askBody);
      s.phase = 'body';
      return;
    }
    case 'body': {
      const b = parseBody(text);
      if (!b) { await talk(psid, COPY.askBody); return; }
      s.body = b;
      await talk(psid, COPY.ackBody(b));
      await talk(psid, COPY.askTrans);
      s.phase = 'trans';
      return;
    }
    case 'trans': {
      const t = parseTrans(text);
      if (!t) { await talk(psid, COPY.askTrans); return; }
      s.trans = t;
      await talk(psid, COPY.ackTrans(t));
      if (s.plan === 'cash') await talk(psid, COPY.askBudgetCash);
      else await talk(psid, COPY.askBudgetFin);
      s.phase = 'budget';
      return;
    }
    case 'budget': {
      if (!validText(text)) {
        if (s.plan === 'cash') await talk(psid, COPY.askBudgetCash);
        else await talk(psid, COPY.askBudgetFin);
        return;
      }
      s.budget = text.trim();
      await talk(psid, COPY.ackBudget);
      await talk(psid, COPY.searching);
      s.phase = 'ready';
      await offerMatches(psid, s);
      return;
    }
    case 'ready': {
      // Picks and gallery
      const pick = parsePick(text);
      if (pick) {
        const chosen = s.offer?.[pick - 1];
        if (chosen) {
          await talk(psid, COPY.afterPick(prettyTitle(chosen)));
          await sendFullGallery(psid, chosen);
          return;
        }
      }
      if (/more\s+photos|full\s+photos/i.test(text)) {
        const chosen = s.offer?.[0];
        if (chosen) { await sendFullGallery(psid, chosen); return; }
      }
      // Model pivot
      if (mh) {
        s.modelHint = mh;
        await talk(psid, `Sige, titingnan ko ang options for ${mh}.`);
        await offerMatches(psid, s);
        return;
      }
      // Nudge
      await talk(psid, `Kung may ibang target model ka, sabihin mo lang (hal. “Vios” o “NV350”). ` +
                       `Kapag gusto mo ng ibang options, sabihin mo “hanap ulit”.`);
      return;
    }
    default:
      await talk(psid, COPY.askPlan);
      s.phase = 'plan';
  }
}

function snapshotQual(s) {
  const bits = [];
  if (s.plan) bits.push(`plan: ${s.plan}`);
  if (s.location) bits.push(`loc: ${s.location}`);
  if (s.body) bits.push(`body: ${s.body}`);
  if (s.trans) bits.push(`trans: ${s.trans}`);
  if (s.budget) bits.push(`budget: ${s.budget}`);
  return bits.join(', ');
}

async function offerMatches(psid, s) {
  const inv = await fetchInventory(INVENTORY_URL);
  const input = {
    plan: s.plan,
    location: s.location,
    body: s.body,
    trans: s.trans,
    budget: s.budget,
    modelHint: s.modelHint
  };

  const { items, usedPriority } = matchTopTwo(inv.items || [], input);
  if (!items || items.length === 0) { await talk(psid, COPY.nothingFound); return; }
  if (!usedPriority) await talk(psid, COPY.proceedNonPriority);

  await talk(psid, COPY.offerIntro);
  s.offer = items.map(parseInventoryItem);

  for (let i = 0; i < s.offer.length; i++) {
    const it = s.offer[i];
    if (it.image_1) await sendImage(psid, it.image_1);

    const title = prettyTitle(it);
    const allInNumber = Number(it.all_in || it.price_all_in || it['all-in'] || 0);
    const allInText = isFinite(allInNumber) && allInNumber > 0
      ? '₱' + allInNumber.toLocaleString('en-PH')
      : (it.srp ? '₱' + Number(it.srp).toLocaleString('en-PH') : '—');

    const locBits = [it.city, it.province].filter(Boolean).join(', ');
    const mileageText = (it.mileage && isFinite(Number(it.mileage)))
      ? ' — ' + Number(it.mileage).toLocaleString('en-PH') + ' km'
      : '';

    const caption = `#${i + 1} ${title}\nAll-in: ${allInText}\n${locBits}${mileageText}`;
    await talk(psid, caption);
  }

  await talk(psid, COPY.whichPick);
  await talk(psid, COPY.galleryHint);
}

async function sendFullGallery(psid, item) {
  const imgs = [
    item.image_1, item.image_2, item.image_3, item.image_4, item.image_5,
    item.image_6, item.image_7, item.image_8, item.image_9, item.image_10
  ].filter(Boolean).slice(0, 10);

  for (const url of imgs) {
    await sendImage(psid, url);
  }
}
