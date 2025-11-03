// api/webhook.js
import { sendText, sendImage } from './lib/messenger.js';
import { humanizeOpt, detectName } from './lib/llm.js';
import { matchTopTwo, parseInventoryItem, fetchInventory } from './lib/matching.js';

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const INVENTORY_URL = process.env.INVENTORY_API_URL;
const ENABLE_TONE = (process.env.ENABLE_TONE_LLM || '0') === '1';

// -------- In-memory session --------
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
    phase: 'start',
    plan: null,
    location: null,
    body: null,
    trans: null,
    budget: null,
    modelHint: null,
    offer: null,
    name: null
  };
  s.updatedAt = now();
  SESSIONS.set(psid, s);
  return s;
}
function resetSession(psid) { SESSIONS.delete(psid); }

// -------- Helpers --------
async function talk(psid, text) {
  const out = ENABLE_TONE ? await humanizeOpt(text) : text;
  await sendText(psid, out);
}
const normalize = (t='') => t.trim().toLowerCase();
const isRestart = (t) => /^(restart|start over|reset)$/.test(normalize(t));
const sniffModelHint = (t='') => {
  const m = t.match(/\b(vios|mirage|city|accent|fortuner|innova|xtrail|civic|corolla|nv350|hiace|raize|br-v|xle|glx|gls|e|g|vx)\b/i);
  return m ? m[0] : null;
};

// -------- Copy --------
const COPY = {
  welcomeNew: (name) =>
`Hi${name ? ' ' + name : ''}! 👋 I’m your BentaCars consultant.
Tulungan kita maghanap ng **best match** para di ka na endless scroll. 🙂
Quick lang — cash ba o financing ang plan mo?`,
  welcomeBack: (snap) =>
`Welcome back! 👋 Last time, napag-usapan natin: **${snap}**.
Gusto mo bang ituloy yun, or type **restart** para magsimula ulit?`,
  askPlan: `Para ma-match ka nang maayos, cash ba o financing ang plan mo? 🙂`,
  ackPlan: (p) => `Got it — **${p}** ✅`,
  askLocation: `Saan ka base para madaling tingnan ang malapit na units? (city/province)`,
  ackLocation: (loc) => `Sige, **${loc}**. Marami tayong ma-check diyan. ✅`,
  askBody: `Anong type ang gusto mo? *Sedan, SUV, MPV, Van, Pickup* — or **any** kung flexible ka.`,
  ackBody: (b) => `Copy — **${b}** type. ✅`,
  askTrans: `Transmission? *Automatic* o *Manual* — pwede ring **any**.`,
  ackTrans: (t) => `Noted — **${t}**. ✅`,
  askBudgetCash: `Last na: mga magkano ang **cash budget** mo? (e.g., ₱450k–₱600k)`,
  askBudgetFin: `Last na: mga magkano ang **ready cash-out / all-in** range mo? (e.g., 150k–220k)`,
  ackBudget: `Salamat! ✅ Sapat na yan para ma-filter ko nang ayos.`,
  searching: `Sige, i-scan ko na ang inventory para sa pinaka-swak na dalawa (priority muna).`,
  noExactButExpand: `Walang exact sa strict filters. Okay lang bang i-relax ko nang kaunti para may maipakita agad?`,
  offerIntro: `Ito yung pinaka-swak sa details mo *(priority muna)*:`,
  whichPick: `Alin ang mas gusto mo, **#1** o **#2**? Pwede ring sabihin mo ang model name.`,
  galleryHint: `Sabihin mo lang **“more photos”** o **“full photos of #1/#2”** para isend ko lahat ng pics.`,
  nothingFound: `Wala pa rin akong makita na pasok. Pwede tayong mag-adjust ng **budget** or **nearby cities** para magka-options agad.`,
  proceedNonPriority: `Walang Priority tag sa filters mo, so nag-proceed ako sa best matches na available.`,
  afterPick: (title) => `Great choice! **${title}**. Isesend ko ang full photos — then pwede na rin tayong mag-schedule ng viewing.`,
  scheduled: `Noted. Iche-check ko ang schedule options and ibabalik ko sayo.`
};

// -------- Webhook --------
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

    // Body parsing (Vercel usually provides req.body already)
    let body = req.body;
    if (!body || (typeof body === 'string' && !body.length)) {
      try { body = await req.json(); } catch { body = null; }
    }
    if (!body || body.object !== 'page') return res.status(200).json({ ok: true });

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender && event.sender.id;
        if (!senderId) continue;

        if (event.message && event.message.text) {
          await handleText(senderId, event.message.text, event);
        } else if (event.postback && event.postback.payload) {
          await handleText(senderId, event.postback.payload, event);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
}

// -------- Conversation engine --------
async function handleText(psid, rawText, event) {
  const text = rawText || '';
  const s = ensureSession(psid);
  if (!s.name) s.name = detectName(event) || null;

  if (isRestart(text)) {
    resetSession(psid);
    const ns = ensureSession(psid);
    await talk(psid, COPY.welcomeNew(s.name));
    ns.phase = 'plan';
    return;
  }

  const mh = sniffModelHint(text);
  if (mh) s.modelHint = mh;

  if (s.phase === 'start') {
    const snap = snapshotQual(s);
    if (snap) await talk(psid, COPY.welcomeBack(snap));
    else { await talk(psid, COPY.welcomeNew(s.name)); s.phase = 'plan'; }
    return;
  }

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
      await talk(psid, s.plan === 'cash' ? COPY.askBudgetCash : COPY.askBudgetFin);
      s.phase = 'budget';
      return;
    }
    case 'budget': {
      if (!validText(text)) {
        await talk(psid, s.plan === 'cash' ? COPY.askBudgetCash : COPY.askBudgetFin);
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
      if (mh) {
        s.modelHint = mh;
        await talk(psid, `Sige, titingnan ko ang options for **${mh}**.`);
        await offerMatches(psid, s);
        return;
      }
      await talk(psid, `Kung may ibang target model ka, sabihin mo lang (hal. “Vios” o “NV350”). Kapag gusto mo ng ibang options, sabihin mo “hanap ulit”.`);
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

function parsePlan(t) {
  const s = normalize(t);
  if (/\bcash\b/i.test(s)) return 'cash';
  if (/financ/i.test(s)) return 'financing';
  return null;
}
function parseBody(t) {
  const s = normalize(t);
  if (/\bsedan\b/.test(s)) return 'sedan';
  if (/\bsuv\b/.test(s)) return 'suv';
  if (/\bmpv\b/.test(s)) return 'mpv';
  if (/\bvan\b/.test(s)) return 'van';
  if (/\bpick(?:up)?\b/.test(s)) return 'pickup';
  if (/\bany\b/.test(s)) return 'any';
  return null;
}
function parseTrans(t) {
  const s = normalize(t);
  if (/auto/.test(s)) return 'automatic';
  if (/manu/.test(s)) return 'manual';
  if (/\bany\b/.test(s)) return 'any';
  return null;
}
function parsePick(t) {
  const s = normalize(t);
  const m = s.match(/\b([12])\b/);
  return m ? parseInt(m[1], 10) : null;
}
function validText(t) { return t && t.trim().length >= 2; }
function prettyTitle(item) {
  return `${item.year} ${item.brand} ${item.model}${item.variant ? ' ' + item.variant : ''}`.trim();
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
    // image_1
    if (it.image_1) await sendImage(psid, it.image_1);

    // Safe caption (no nested template strings)
    const title = prettyTitle(it);
    const allInNumber = Number(it.all_in || it.price_all_in || 0);
    const allInText = isFinite(allInNumber) && allInNumber > 0
      ? '₱' + allInNumber.toLocaleString('en-PH')
      : '—';
    const locBits = [it.city, it.province].filter(Boolean).join(', ');
    const mileageText = (it.mileage && isFinite(Number(it.mileage)))
      ? ' — ' + Number(it.mileage).toLocaleString('en-PH') + ' km'
      : '';
    const caption = `#${i + 1} 🚗 **${title}**
All-in: **${allInText}**
${locBits}${mileageText}`;

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
