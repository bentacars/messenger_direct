export const config = { runtime: 'edge' };

import {
  sendText, sendTypingOn, sendTypingOff,
  sendImage, sendQuickReplies, sendGenericTemplate
} from './lib/messenger.js';
import { humanize, parseUtterance, shortMoney, allInBracket } from './lib/llm.js';
import { rankMatches } from './lib/matching.js';

const USE_CAROUSEL = false; // set true to try Messenger carousel
const STATE_TTL_MS = 30 * 60 * 1000; // 30 min memory

// simple in-memory state (Edge instance—good enough for now)
const S = new Map(); // psid -> {ts, data}

function getState(psid) {
  const now = Date.now();
  const rec = S.get(psid);
  if (!rec || (now - rec.ts) > STATE_TTL_MS) {
    const fresh = {
      ts: now,
      data: {
        step: 'greet',
        name: null,
        plan: null,           // 'cash' | 'financing'
        location: null,       // free text city/province
        body_type: null,      // sedan/suv/mpv/van/pickup/any
        transmission: null,   // automatic/manual/any
        budget: null,         // number-ish (cash or all-in depending on plan)
        model: null,          // "Mirage", "Vios", etc.
        brand_model: null,    // "Toyota Vios"
        lastOffers: [],       // [{sku,...}]
      }
    };
    S.set(psid, fresh);
    return fresh.data;
  }
  rec.ts = now;
  return rec.data;
}
function resetState(psid){ S.delete(psid); return getState(psid); }

async function fetchInventory() {
  const url = process.env.INVENTORY_API_URL;
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json();
  if (!j || !j.ok) return [];
  return Array.isArray(j.items) ? j.items : [];
}

function cashLine(it){
  const srp = it?.srp ?? it?.cash_price ?? null;
  return srp ? `Cash: ₱${shortMoney(srp)} (negotiable upon actual viewing)` : `Cash price on viewing (negotiable)`;
}
function finLine(it){
  const ai = it?.price_all_in ?? it?.all_in ?? null;
  if (!ai) return `All-in available this month (subject to approval).`;
  const [lo, hi] = allInBracket(ai);
  return `All-in: ₱${shortMoney(lo)}–₱${shortMoney(hi)} (promo, subject to approval). Standard DP ~20% of unit price.`;
}
function cityLine(it){
  const city = it?.city || it?.complete_address || it?.province || 'Metro Manila';
  const km = it?.mileage ? `${Number(it.mileage).toLocaleString()} km` : '';
  return `${city}${km ? ` — ${km}` : ''}`;
}

function unitCaption(it, plan){
  const yr = it?.year ? `${it.year} ` : '';
  const title = `${yr}${it.brand} ${it.model}${it.variant ? ` ${it.variant}` : ''}`.trim();
  const priceBit = plan === 'cash' ? cashLine(it) : finLine(it);
  return `🚗 ${title}\n${priceBit}\n${cityLine(it)}`;
}

// Build a human short ask line per step
function nextAsk(state){
  if (!state.plan) return `Cash or financing ang plan mo?`;
  if (!state.location) return `Saan location mo? (city/province)`;
  if (!state.body_type) return `Anong body type? (sedan/suv/mpv/van/pickup — or ‘any’)`;
  if (!state.transmission) return `Auto or manual? (pwede rin ‘any’)`;
  if (!state.budget) {
    if (state.plan === 'cash') return `Cash budget range? (e.g., 450k–600k)`;
    return `Ready cash-out / all-in range? (e.g., 80k–120k)`;
  }
  return null;
}

// ----- webhook

export default async function handler(req) {
  if (req.method === 'GET') {
    // FB verification
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('OK');

  const body = await req.json().catch(()=>null);
  if (!body?.entry?.[0]?.messaging?.[0]) return new Response('OK');

  const m = body.entry[0].messaging[0];
  const psid = m.sender?.id;
  const text = (m.message?.text || '').trim();

  if (!psid) return new Response('OK');

  // ignore echoes / delivery
  if (m.message?.is_echo) return new Response('OK');

  const state = getState(psid);

  // reset
  if (/^\s*restart\s*$/i.test(text)) {
    resetState(psid);
    await sendTypingOn(psid);
    await sendText(psid, `Reset na. Let’s start fresh. 🙂`);
    await sendTypingOff(psid);
    await sendText(psid, `Cash or financing ang plan mo?`);
    return new Response('OK');
  }

  // soft small-talk guard
  if (/^(hi|hello|hey|\u2764|ok|okay|thanks?|ty)$/i.test(text)) {
    if (state.step === 'greet') {
      await sendText(psid, `Hi! 👋 I’m your BentaCars consultant. Tutulungan kitang ma-match sa best unit para di ka na mag-scroll nang mag-scroll.`);
      await sendText(psid, `Cash or financing ang plan mo?`);
      state.step = 'qualify';
      return new Response('OK');
    }
    const ask = nextAsk(state);
    if (ask) await sendText(psid, ask);
    return new Response('OK');
  }

  // parse this turn
  const upd = parseUtterance(text);
  // Prefer explicit user info; don’t overwrite set fields unless new value appears
  for (const k of ['plan','location','body_type','transmission','budget','model','brand_model']) {
    if (upd[k] && !state[k]) state[k] = upd[k];
  }

  // if user typed "1"/"2" selection
  if (/^\s*(1|2)\s*$/.test(text) && state.lastOffers?.length) {
    const idx = Number(text.trim()) - 1;
    const pick = state.lastOffers[idx];
    if (pick) {
      await sendTypingOn(psid);
      await sendText(psid, `Nice pick! Sending full photos…`);
      // full gallery
      const imgs = [];
      for (let i=1;i<=10;i++){
        const key = i===1 ? 'image_1' : `image_${i}`;
        const url = pick[key];
        if (url) imgs.push(url);
      }
      for (const u of imgs) { await sendImage(psid, u); }
      await sendTypingOff(psid);
      await sendText(psid, `Gusto mo bang i-schedule ang viewing? (yes/no)`);
      return new Response('OK');
    }
  }

  // ask flow
  const ask = nextAsk(state);
  if (ask) {
    await sendText(psid, humanize.ask(ask, state));
    return new Response('OK');
  }

  // we have enough to match
  await sendTypingOn(psid);
  const items = await fetchInventory();

  const ranked = rankMatches(items, {
    plan: state.plan,
    location: state.location,
    body_type: state.body_type,
    transmission: state.transmission,
    budget: state.budget,
    model: state.model,
    brand_model: state.brand_model
  });

  if (!ranked.length) {
    await sendTypingOff(psid);
    await sendText(psid, `Walang exact match sa filters mo. Pwede nating i-adjust konti (budget or body type) para may maipakita ako. Type **others** para i-relax natin.`);
    return new Response('OK');
  }

  // prepare top 2
  const top = ranked.slice(0, 2);
  state.lastOffers = top;

  if (USE_CAROUSEL && top.length > 1) {
    const cards = top.map((it, i) => ({
      title: `${it.year || ''} ${it.brand} ${it.model}${it.variant ? ` ${it.variant}` : ''}`.trim(),
      subtitle: (state.plan === 'cash' ? cashLine(it) : finLine(it)) + `\n${cityLine(it)}`,
      image_url: it.image_1 || it.image || null,
      buttons: [
        { type: 'postback', title: `Pick #${i+1}`, payload: String(i+1) },
        { type: 'postback', title: 'More photos', payload: `more ${i+1}` }
      ]
    }));
    await sendGenericTemplate(psid, cards);
    await sendTypingOff(psid);
    await sendText(psid, `Choose **1** or **2**. Type **more 1** / **more 2** for full photos. Type **others** if you want more options.`);
    return new Response('OK');
  }

  // image_1 per unit + caption
  await sendText(psid, `Ito yung best na swak sa details mo (priority muna kung meron):`);
  for (const it of top) {
    if (it.image_1) await sendImage(psid, it.image_1);
    await sendText(psid, unitCaption(it, state.plan));
  }
  await sendTypingOff(psid);
  await sendText(psid, `Type **1** or **2** to pick. Type **more 1** / **more 2** for full photos. Type **others** if you want more options.`);
  return new Response('OK');
}
