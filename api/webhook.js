// api/webhook.js
import { sendText, sendTypingOn, sendTypingOff, sendImage } from './lib/messenger.js';
import { smartReply, detectModelFromText, normalizeBudget, greet, shouldReset } from './lib/llm.js';

// In-memory session (okay for now; you’ll later swap to Redis/DB)
const SESS = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1h

function getSession(id) {
  const now = Date.now();
  const s = SESS.get(id);
  if (!s || (now - s.t) > SESSION_TTL_MS) {
    const fresh = { t: now, step: 'plan', data: {}, lastModelsCache: [], lastShown: [] };
    SESS.set(id, fresh);
    return fresh;
  }
  s.t = now;
  return s;
}
function resetSession(id) {
  const fresh = { t: Date.now(), step: 'plan', data: {}, lastModelsCache: [], lastShown: [] };
  SESS.set(id, fresh);
  return fresh;
}

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// --- Inventory fetch + match helpers ---
const INV_URL = process.env.INVENTORY_API_URL; // your Apps Script endpoint

async function fetchInventory() {
  const res = await fetch(INV_URL, { method: 'GET', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`Inventory fetch failed: ${res.status}`);
  const js = await res.json();
  return Array.isArray(js.items) ? js.items : [];
}

function scoreItem(it, want) {
  let s = 0;
  // priority boost
  if ((it.price_status || '').toLowerCase().includes('priority')) s += 5;
  // body match
  if (want.body && it.body_type && it.body_type.toLowerCase() === want.body) s += 3;
  // trans match
  if (want.trans && it.transmission && it.transmission.toLowerCase().startsWith(want.trans)) s += 2;
  // city proximity (simple contains check)
  if (want.city && it.city && it.city.toLowerCase().includes(want.city)) s += 1;
  // model hint
  if (want.model && it.model && it.model.toLowerCase().includes(want.model)) s += 2;
  // budget fit
  if (want.plan === 'cash') {
    const price = Number(it.srp || 0);
    if (want.cashMin != null && want.cashMax != null && price >= want.cashMin && price <= want.cashMax) s += 3;
  } else if (want.plan === 'financing') {
    const allin = Number(it.all_in || 0);
    if (want.allinMin != null && want.allinMax != null && allin >= want.allinMin && allin <= want.allinMax) s += 3;
  }
  return s;
}

function pickTop(items, want, n = 2) {
  const withScores = items.map(it => ({ it, s: scoreItem(it, want) }));
  // First pass: if any Priority exist, prefer them (they already have +5)
  withScores.sort((a, b) => b.s - a.s);
  const top = withScores.slice(0, n).map(x => x.it);
  // If scores are all zero (super weak), still return first N fallback
  if (top.length < n) {
    const pad = items.slice(0, n - top.length);
    return top.concat(pad);
  }
  return top;
}

function shortCardText(it) {
  const yr = it.year ? `${it.year} ` : '';
  const name = `${yr}${it.brand || ''} ${it.model || ''} ${it.variant || ''}`.replace(/\s+/g, ' ').trim();
  const allin = it.all_in ? `All-in: ₱${Number(it.all_in).toLocaleString('en-PH')}` : (it.srp ? `Cash: ₱${Number(it.srp).toLocaleString('en-PH')}` : '');
  const km = it.mileage ? `${Number(it.mileage).toLocaleString('en-PH')} km` : '';
  const loc = it.city || it.complete_address || '';
  return `🚗 ${name}\n${allin}\n${loc}${km ? ` — ${km}` : ''}`;
}

async function showTwoOffers(psid, picks, sess) {
  if (!picks.length) return;
  await sendTypingOn(psid);
  await sendText(psid, "Ito yung best na swak sa details mo (priority muna kung meron):");
  for (let i = 0; i < Math.min(2, picks.length); i++) {
    const it = picks[i];
    const img = it.image_1 || it.image1 || '';
    if (img) await sendImage(psid, img);
    await sendText(psid, shortCardText(it));
  }
  sess.lastShown = picks.slice(0, 2).map((x, idx) => ({ idx: idx + 1, sku: x.SKU || x.sku || '', drive: x.drive_link || '', allImages: collectImages(x) }));
  await sendText(psid, "Type **1** or **2** to pick. Type **more 1** / **more 2** for full photos. Type **others** if you want more options.");
  await sendTypingOff(psid);
}

function collectImages(it) {
  const imgs = [];
  for (let i = 1; i <= 10; i++) {
    const v = it[`image_${i}`];
    if (v) imgs.push(v);
  }
  return imgs;
}

// --- Qualifier flow controller ---
async function handleMessage(psid, text) {
  const raw = (text || '').trim();
  const low = raw.toLowerCase();

  let sess = getSession(psid);

  // reset?
  if (shouldReset(low)) {
    sess = resetSession(psid);
    await sendText(psid, "Reset na. Let’s start fresh. 🙂");
    await sendText(psid, "Quick lang ito so we can match fast.");
    await sendText(psid, "Cash or financing ang plan mo?");
    sess.step = 'plan';
    return;
  }

  // If user says "more 1/2" or picks 1/2
  if (/^more\s*[12]$/.test(low)) {
    const pickNo = Number(low.replace(/\D/g, ''));
    const chosen = (sess.lastShown || []).find(x => x.idx === pickNo);
    if (!chosen) { await sendText(psid, "Sige, pumili ka muna ng **1** o **2** para maipakita ko ang photos."); return; }
    if (!chosen.allImages?.length) { await sendText(psid, "Wala pang extra photos for this unit. Pwede kitang i-update once available."); return; }
    await sendText(psid, "Here are more photos:");
    for (const url of chosen.allImages) { await sendImage(psid, url); }
    await sendText(psid, "Gusto mo bang i-schedule ang viewing? (yes/no)");
    sess.step = 'viewing';
    return;
  }
  if (/^[12]$/.test(low)) {
    const pickNo = Number(low);
    const chosen = (sess.lastShown || []).find(x => x.idx === pickNo);
    if (!chosen) { await sendText(psid, "Invalid choice. Type **1** or **2**."); return; }
    await sendText(psid, "Nice pick! Gusto mo bang i-schedule ang viewing? (yes/no)\nPwede ring type **more " + pickNo + "** for full photos.");
    sess.step = 'viewing';
    return;
  }
  if (sess.step === 'viewing') {
    if (/(yes|sige|oo|go)/i.test(raw)) {
      await sendText(psid, "Copy! Pakidrop number mo and preferred day/time. I-arrange ko agad. 📅");
    } else {
      await sendText(psid, "Noted. Gusto mo bang makita pa ibang options? Type **others**.");
    }
    return;
  }
  if (low === 'others') {
    // show next two from cache, or refetch with relaxed rules
    await sendTypingOn(psid);
    const inv = sess.lastModelsCache.length ? sess.lastModelsCache : await fetchInventory();
    const want = sess.data || {};
    const others = inv
      .filter(it => !sess.lastShown.find(s => (s.sku && (s.sku === (it.SKU || it.sku || '')))))
      .slice(0, 8); // pool
    const picks = pickTop(others, want, 2);
    await showTwoOffers(psid, picks, sess);
    await sendTypingOff(psid);
    return;
  }

  // Normal greet → don’t loop questions
  if (/^(hi+|hello+|yo+|kumusta|hoy)$/i.test(low)) {
    await sendText(psid, greet(sess));
    if (sess.step === 'plan') await sendText(psid, "Cash or financing ang plan mo?");
    return;
  }

  // Smart model detection: if user mentions a model, record it
  if (!sess.data.model) {
    try {
      if (!sess.lastModelsCache.length) sess.lastModelsCache = await fetchInventory();
      const mdl = detectModelFromText(raw, sess.lastModelsCache);
      if (mdl) { sess.data.model = mdl; }
    } catch {}
  }

  // FLOW: plan → city → body → trans → budget
  switch (sess.step) {
    case 'plan': {
      // expect: cash|financing
      if (/^cash$/i.test(raw)) { sess.data.plan = 'cash'; sess.step = 'city'; await sendText(psid, "Saan location mo? (city/province)"); return; }
      if (/^financ(ing|e)?$/i.test(raw)) { sess.data.plan = 'financing'; sess.step = 'city'; await sendText(psid, "Saan location mo? (city/province)"); return; }
      await sendText(psid, smartReply("plan_retry"));
      return;
    }
    case 'city': {
      sess.data.city = raw.toLowerCase();
      sess.step = 'body';
      await sendText(psid, "Anong body type hanap mo? (sedan/suv/mpv/van/pickup — or type 'any')");
      return;
    }
    case 'body': {
      const b = raw.toLowerCase();
      sess.data.body = (b === 'any') ? '' : b;
      sess.step = 'trans';
      await sendText(psid, "Auto or manual? (pwede rin 'any')");
      return;
    }
    case 'trans': {
      const t = raw.toLowerCase();
      sess.data.trans = (t === 'any') ? '' : (t.startsWith('a') ? 'automatic' : (t.startsWith('m') ? 'manual' : ''));
      sess.step = 'budget';
      if (sess.data.plan === 'cash') {
        await sendText(psid, "Cash budget range? (e.g., 450k-600k)");
      } else {
        await sendText(psid, "Ready all-in cash-out range? (e.g., 150k-220k)");
      }
      return;
    }
    case 'budget': {
      const r = normalizeBudget(raw);
      if (!r) { await sendText(psid, "Pakigayahan in this format: `450k-600k` or `150000-220000`."); return; }
      if (sess.data.plan === 'cash') { sess.data.cashMin = r.min; sess.data.cashMax = r.max; }
      else { sess.data.allinMin = r.min; sess.data.allinMax = r.max; }

      // READY TO MATCH
      await sendTypingOn(psid);
      const inv = await fetchInventory();
      sess.lastModelsCache = inv;

      // filter coarse
      const pool = inv.filter(it => {
        // used cars only (we simply accept all; your sheet is used-car)
        // body
        if (sess.data.body && it.body_type && it.body_type.toLowerCase() !== sess.data.body) return false;
        // trans
        if (sess.data.trans) {
          const tt = (it.transmission || '').toLowerCase();
          if (!tt.startsWith(sess.data.trans)) return false;
        }
        // budget coarse
        if (sess.data.plan === 'cash') {
          const price = Number(it.srp || 0);
          if (sess.data.cashMin != null && price < sess.data.cashMin) return false;
          if (sess.data.cashMax != null && price > sess.data.cashMax) return false;
        } else {
          const allin = Number(it.all_in || 0);
          if (sess.data.allinMin != null && allin < sess.data.allinMin) return false;
          if (sess.data.allinMax != null && allin > sess.data.allinMax) return false;
        }
        // city soft check (we don’t exclude if empty)
        return true;
      });

      let picks = pickTop(pool.length ? pool : inv, sess.data, 2); // fallback to full inv if too strict
      await showTwoOffers(psid, picks, sess);
      await sendTypingOff(psid);
      sess.step = 'post_offers';
      return;
    }
    default: {
      // After offers, be helpful
      if (/^model\s+(.+)/i.test(raw)) {
        sess.data.model = raw.replace(/^model\s+/i, '').toLowerCase();
        await sendText(psid, "Noted. Iche-check ko with that model in mind.");
        sess.step = 'budget';
        await sendText(psid, (sess.data.plan === 'cash')
          ? "Cash budget range? (e.g., 450k-600k)"
          : "Ready all-in cash-out range? (e.g., 150k-220k)");
        return;
      }
      await sendText(psid, "Got it. If you want to start over, type **restart**. To see other units, type **others**.");
      return;
    }
  }
}

// ---- Vercel (Node runtime) webhook ----
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // webhook verification
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const body = await readBody(req);

    if (body.object !== 'page') return res.status(200).json({ ok: true });

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const psid = event.sender?.id;
        if (!psid) continue;
        const text =
          event.message?.text ??
          event.postback?.title ??
          event.postback?.payload ?? '';

        if (!text) continue;

        await handleMessage(psid, text);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
