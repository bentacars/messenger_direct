// api/webhook.js (ESM) — Node runtime (no config line)

import { sendText, sendTypingOn, sendTypingOff, sendImage, sendQuickReplies, validatePsid } from './lib/messenger.js';
import {
  parseBuyerMessage as parseUtterance,
  nextMissingSlot, promptForSlot,
  itemTitle, composePriceLine, shortDetail,
  allInBracket, shortMoney, ask as askLine,
  pickModel, pickTemp
} from './lib/llm.js';

// Ready for future LLM use (not required for rule-based flow yet)
const MODEL = pickModel(process.env.MODEL_DEFAULT, 'gpt-4.1-mini');
const TEMP  = pickTemp(process.env.TEMP_DEFAULT, 0.35);

const INV_URL = process.env.INVENTORY_API_URL;
if (!INV_URL) console.warn('Missing INVENTORY_API_URL');

// --- in-memory sessions
const SESS = new Map(); // psid -> state

function newState(){
  return {
    plan: null,
    location: null,
    body_type: null,
    transmission: null,
    // budgets
    max_cash: null,
    min_cash: null,
    approx_cash: null,
    // preferences
    model: null,
    brand: null,
    variant: null,
    // offers
    lastOffers: []
  };
}
function getState(psid){ if(!SESS.has(psid)) SESS.set(psid, newState()); return SESS.get(psid); }
function reset(psid){ SESS.set(psid, newState()); }

// --- helpers
function norm(s){ return String(s || '').trim().toLowerCase(); }
function primaryImage(item){
  return item.image_1 || item.image_2 || item.image_3 || item.image_4 || item.image_5 || null;
}
function allImages(item){
  const imgs = [];
  for(let i=1;i<=10;i++){ const k = i===1?'image_1':`image_${i}`; if(item[k]) imgs.push(item[k]); }
  return imgs;
}
function peso(n){ return `₱${Number(n).toLocaleString('en-PH',{maximumFractionDigits:0})}`; }

async function fetchInventory(){
  const res = await fetch(`${INV_URL}`, { method:'GET', headers:{'Content-Type':'application/json'}, cache:'no-store' });
  const data = await res.json().catch(()=>null);
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

// Scoring & matching
function scoreItem(it, q){
  let sc = 0;
  if (q.body_type && norm(it.body_type) === norm(q.body_type)) sc += 4;
  if (q.transmission && norm(it.transmission) === norm(q.transmission)) sc += 3;
  if (q.model && (norm(it.model).includes(norm(q.model)) || norm(`${it.brand} ${it.model}`).includes(norm(q.model)))) sc += 3;
  if (q.brand && norm(it.brand) === norm(q.brand)) sc += 2;

  // budget: cash uses SRP; financing uses all_in
  const srp = Number(it.srp || it.cash_price || 0);
  const allin = Number(it.price_all_in || it.all_in || 0);
  const max = q.max_cash || q.approx_cash || q.min_cash || null;
  if (q.plan === 'cash' && max && srp && srp <= max) sc += 4;
  if (q.plan === 'financing' && max && allin && allin <= (max + 20000)) sc += 4;

  // priority boost
  if (norm(it.price_status) === 'priority') sc += 10;

  // images boost
  if (primaryImage(it)) sc += 2;

  // mileage light boost
  const km = Number(it.mileage || 0);
  if (km && km < 30000) sc += 1;

  return sc;
}

function pickPriceText(item, plan){
  if (plan === 'cash') {
    const srp = Number(item.srp || item.cash_price || 0);
    if (!srp) return `SRP: (ask)\n${shortDetail(item)}`;
    return `SRP: ${peso(srp)} (negotiable upon viewing)\n${shortDetail(item)}`;
  }
  const raw = Number(item.price_all_in || item.all_in || 0);
  if (!raw) return `All-in available (ask)\n${shortDetail(item)}`;
  // Financing bracket: round up to 5k, then +20k
  const low = Math.ceil(raw/5000)*5000;
  const hi  = low + 20000;
  return [
    `All-in: ${peso(low)}–${peso(hi)} (negotiable & subject for approval — promo this month)`,
    `Standard is ~20% DP of the unit price.`,
    shortDetail(item)
  ].join('\n');
}

function titleFor(item){
  const yr = item.year ? `${item.year} ` : '';
  const title = `${yr}${item.brand||''} ${item.model||''}${item.variant ? ' ' + item.variant : ''}`;
  return `🚗 ${title}`.replace(/\s+/g,' ').trim();
}

// --- HTTP handler (Node runtime)
export default async function handler(req, res){
  try {
    if (req.method === 'GET') {
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
    if (body.object !== 'page') return res.status(200).send('ok');

    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        const psid = ev.sender?.id ? validatePsid(String(ev.sender.id)) : null;
        if (!psid) continue;

        if (ev.message?.text) {
          await handleMessage(psid, ev.message.text);
        } else if (ev.postback?.payload) {
          await handleMessage(psid, ev.postback.payload);
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (e) {
    console.error('webhook error', e);
    res.status(200).send('ok');
  }
}

// Safe JSON body reader
async function readBody(req){
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  await new Promise((r)=>{
    req.on('data', c=>chunks.push(c));
    req.on('end', r);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

// ---- Conversation core
async function handleMessage(psid, raw) {
  const text = raw.trim();
  const s = getState(psid);

  // restart
  if (/^\s*(restart|reset|start over)\s*$/i.test(text)) {
    reset(psid);
    await sendText(psid, `Reset na. Let’s start fresh. 🙂`);
    await sendText(psid, `Cash or financing ang plan mo?`);
    return;
  }

  // friendly greeting handling
  if (/^(hi|hello|hey|yo|kumusta|good\s*(am|pm)|gandang araw)$/i.test(text)) {
    if (!s.plan && !s.location) {
      await sendText(psid, `Hi! 👋 I’m your BentaCars consultant. Tutulungan kitang ma-match sa best unit para di ka na mag-scroll nang mag-scroll.`);
      await sendText(psid, `Cash or financing ang plan mo?`);
      return;
    }
  }

  // parse this user turn
  const u = parseUtterance(text);
  // merge new info only if missing
  for (const k of ['plan','location','body_type','transmission','brand','model','variant','max_cash','min_cash','approx_cash']) {
    if (u[k] && !s[k]) s[k] = u[k];
  }

  // handle selection commands anytime after offers
  if (/^\s*more\s*[12]\s*$/i.test(text)) {
    const pick = Number(text.replace(/[^\d]/g,'')) - 1;
    const offer = s.lastOffers?.[pick];
    if (offer) {
      const imgs = allImages(offer);
      if (imgs.length) {
        await sendTypingOn(psid);
        for (const u of imgs) await sendImage(psid, u);
        await sendTypingOff(psid);
        await sendText(psid, `Gusto mo bang i-schedule ang viewing? (yes/no)`);
      } else {
        await sendText(psid, `Wala pang full gallery for this unit — puwede nating i-schedule ang viewing para makita nang buo.`);
      }
      return;
    }
  }
  if (/^\s*[12]\s*$/i.test(text)) {
    const idx = Number(text.trim()) - 1;
    const offer = s.lastOffers?.[idx];
    if (offer) {
      await sendText(psid, `Nice pick! ${titleFor(offer)}\n${pickPriceText(offer, s.plan)}\n\nGusto mo bang i-schedule ang viewing? (yes/no)\nPwede ring i-type **more ${idx+1}** para sa full photos.`);
      return;
    }
  }
  if (/^\s*others?\s*$/i.test(text)) {
    // relax filters (ignore city/body) but keep plan/budget/trans
    const s2 = { ...s, location: null, body_type: null };
    await showOffers(psid, s2);
    return;
  }

  // ask next missing slot
  const missing = nextMissingSlot(s);
  if (missing) {
    await sendText(psid, askLine(missing));
    return;
  }

  // we have enough to match → show offers
  await showOffers(psid, s);
}

async function showOffers(psid, st){
  const all = await fetchInventory();
  if (!all.length) {
    await sendText(psid, `Medyo loaded yung inventory ko ngayon. Try again in a bit please. 🙏`);
    return;
  }

  // hard filter a bit
  let cand = all.filter(it => {
    if (st.body_type && st.body_type !== 'any' && norm(it.body_type) !== norm(st.body_type)) return false;
    if (st.transmission && st.transmission !== 'any' && !norm(it.transmission).includes(norm(st.transmission))) return false;
    // budget
    const srp = Number(it.srp || it.cash_price || 0);
    const allin = Number(it.price_all_in || it.all_in || 0);
    const max = st.max_cash || st.approx_cash || st.min_cash || null;
    if (st.plan === 'cash' && max && srp && srp > max) return false;
    if (st.plan === 'financing' && max && allin && allin > max + 20000) return false;
    return true;
  });

  if (!cand.length) {
    await sendText(psid, `Walang exact match sa filters mo. Pwede nating i-adjust konti (budget or body type) para may maipakita ako. Type **others** para i-relax natin.`);
    return;
  }

  // score & sort
  cand = cand.map(it => ({ it, score: scoreItem(it, st) }))
             .sort((a,b)=> b.score - a.score)
             .map(x=>x.it);

  // Priority first (but fallback to others)
  const prio = cand.filter(x => norm(x.price_status) === 'priority');
  const rest = cand.filter(x => norm(x.price_status) !== 'priority');
  const chosen = [...prio.slice(0,2)];
  if (chosen.length < 2) chosen.push(...rest.slice(0, 2 - chosen.length));

  if (!chosen.length) {
    await sendText(psid, `Walang priority na pasok pero may iba pang options. Type **others** para ipakita ko.`);
    return;
  }

  sET(psid, chosen); // store last offers

  await sendTypingOn(psid);
  await sendText(psid, `Ito yung best na swak sa details mo (priority muna kung meron):`);
  for (const it of chosen) {
    const img = primaryImage(it);
    if (img) await sendImage(psid, img);
    await sendText(psid, `${titleFor(it)}\n${pickPriceText(it, st.plan)}`);
  }
  await sendTypingOff(psid);

  await sendQuickReplies(psid,
    `Pili ka: **1** or **2**. For full photos, type **more 1** / **more 2**. Need more options? Type **others**.`,
    [
      { title:'1', payload:'PICK_1' },
      { title:'2', payload:'PICK_2' },
      { title:'Others', payload:'OTHERS' }
    ]
  );
}

function sET(psid, offers){ const s = getState(psid); s.lastOffers = offers; SESS.set(psid, s); }
