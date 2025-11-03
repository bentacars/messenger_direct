// api/webhook.js
import { sendText, sendTypingOn, sendTypingOff, sendImage, sendQuickReplies, sendGenericTemplate } from './lib/messenger.js';
import { scoreAndSelect } from './lib/matching.js';

const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMP_DEFAULT  = Number(process.env.TEMP_DEFAULT || 0.30);
const INVENTORY_API_URL = process.env.INVENTORY_API_URL;

const SESSIONS = new Map(); // in-memory (ok for your current dev)

function initSession(id) {
  if (!SESSIONS.has(id)) {
    SESSIONS.set(id, {
      phase: 'qualify',
      collected: {
        payment: null,         // 'cash' | 'financing'
        location: null,        // 'quezon city'
        body_type: null,       // 'sedan' | 'suv' | 'mpv' | 'van' | 'pickup' | 'any'
        transmission: null,    // 'automatic' | 'manual' | 'any'
        budget_cash: null,     // e.g. {min:450000,max:600000}
        budget_allin: null,    // for financing (cash-out)
        model: null,           // 'mirage' (optional)
        brand: null,           // 'toyota' (optional)
        year: null             // 2019 (optional)
      },
      lastOffers: [],          // array of car objects
      selected: null,          // picked car
    });
  }
  return SESSIONS.get(id);
}

function normalizeText(s='') {
  return String(s).trim().toLowerCase();
}

// lightweight NLP for auto-detect
function detectHints(txt) {
  const t = normalizeText(txt);
  const hints = {};
  if (/financ(ing|e)|loan|hulugan|all[- ]?in|cash[- ]?out/.test(t)) hints.payment = 'financing';
  if (/\b(cash|spot cash|full cash|straight)\b/.test(t)) hints.payment = 'cash';

  if (/\bautomatic\b|auto\b/.test(t)) hints.transmission = 'automatic';
  if (/\bmanual\b/.test(t)) hints.transmission = 'manual';

  if (/\b(sedan|suv|van|mpv|pickup|pick[- ]?up)\b/.test(t)) {
    const m = t.match(/\b(sedan|suv|van|mpv|pickup|pick[- ]?up)\b/);
    hints.body_type = (m[1] === 'pick-up' || m[1] === 'pick up' || m[1] === 'pick-up') ? 'pickup' : m[1].replace('pick ', 'pick');
  }

  // budget phrases
  if (/below\s*\d+k?|\d+\s*k\s*max/.test(t)) {
    const n = Number(t.replace(/[^0-9]/g,''));
    if (n) hints.budget_cash = {min: 0, max: n * 1000};
  } else if (/(\d+)\s*k\s*to\s*(\d+)\s*k/.test(t)) {
    const m = t.match(/(\d+)\s*k\s*to\s*(\d+)\s*k/);
    hints.budget_cash = {min: Number(m[1])*1000, max: Number(m[2])*1000};
  }

  // model/brand tokens (very simple)
  const brands = ['toyota','honda','mitsubishi','nissan','ford','suzuki','hyundai','kia','isuzu'];
  const models = ['vios','mirage','wigo','city','civic','territory','stargazer','avanza','innova','fortuner','hiace','nv350','livina','raize','almera','accent','brv','br-v','montero','everest'];
  for (const b of brands) if (new RegExp(`\\b${b}\\b`).test(t)) hints.brand = b;
  for (const m of models) if (new RegExp(`\\b${m}\\b`).test(t)) hints.model = m.replace('-','');

  const y = t.match(/\b(20\d{2}|19\d{2})\b/);
  if (y) hints.year = Number(y[1]);

  if (/any\s+(sedan|suv|van|mpv|pickup)/.test(t)) {
    hints.body_type = t.match(/any\s+(sedan|suv|van|mpv|pickup)/)[1];
  }
  if (/\bany\b/.test(t)) {
    hints.body_type ??= 'any';
    hints.transmission ??= 'any';
  }
  return hints;
}

// helpers
function stillNeeds(col) {
  const order = ['payment','location','body_type','transmission','budget'];
  if (!col.payment) return 'payment';
  if (!col.location) return 'location';
  if (!col.body_type && !(col.model || col.brand)) return 'body_type';
  if (!col.transmission && !(col.model)) return 'transmission';
  if (col.payment === 'cash' && !col.budget_cash) return 'budget';
  if (col.payment === 'financing' && !col.budget_allin) return 'budget';
  return null;
}

async function fetchInventory(params) {
  // POST to your Apps Script endpoint
  const q = {
    ...params,
    limit: 12,       // wider fetch, we’ll score client-side
    include_images: true
  };
  const resp = await fetch(INVENTORY_API_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(q)
  });
  if (!resp.ok) throw new Error(`Inventory API ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
}

function buildCaption(car) {
  const year  = car.year || '';
  const brand = car.brand || '';
  const model = car.model || '';
  const variant = car.variant ? ` ${car.variant}` : '';
  const allin = car.price_all_in || car.all_in || car['all_in'] || car['price_all_in'] || null;
  const km = car.mileage ? `${Number(car.mileage).toLocaleString()} km` : '';
  const city = car.city || car.location || '';
  const priceLine = allin ? `All-in: ₱${Number(allin).toLocaleString()}` : (car.srp ? `Cash: ₱${Number(car.srp).toLocaleString()}` : '');
  return `🚗 ${year} ${brand} ${model}${variant}\n${priceLine}\n${city}${km ? ` — ${km}`:''}`;
}

function carImages(car) {
  const imgs = [];
  for (let i=1;i<=10;i++){
    const key = `image_${i}`;
    if (car[key] && typeof car[key] === 'string' && car[key].startsWith('http')) imgs.push(car[key]);
  }
  return imgs;
}

// -------- Messenger intents (buttons / commands)
function isRestart(txt) { return /\b(restart|reset|start over|new search|ulit tayo)\b/i.test(txt); }
function isMorePhotos(txt) { return /\b(photos|full photos|more photos|view full photos|pictures)\b/i.test(txt); }
function isShowOthers(txt) { return /\b(show other|ibang unit|other options|more options)\b/i.test(txt); }
function isSchedule(txt)   { return /\b(schedule|viewing|test drive|testdrive)\b/i.test(txt); }

// ===== Main handler =====
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // Verification
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const body = req.body || {};
    if (!body.object) return res.status(200).send('OK'); // Not a Messenger webhook

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender && event.sender.id;
        if (!senderId) continue;

        const session = initSession(senderId);

        // Handle text
        if (event.message && event.message.text) {
          const text = event.message.text.trim();

          // Commands
          if (isRestart(text)) {
            SESSIONS.delete(senderId);
            initSession(senderId);
            await sendText(senderId, "Okay! Let's start fresh. Consultant mode tayo—goal namin ma-match ka sa **best unit** (no endless scrolling).");
            await sendQuickReplies(senderId, "Una: Cash ba o Financing ang plan mo? 🙂", [
              {title:'Cash', payload:'PAYMENT_CASH'},
              {title:'Financing', payload:'PAYMENT_FINANCING'}
            ]);
            continue;
          }

          // If in selection mode expecting a choice by title or number
          if (session.phase === 'offer') {
            // Choosing unit by quick reply title or “1/2”
            const idxNum = text.match(/^\s*([12])\s*$/);
            let chosen = null;
            if (idxNum) {
              chosen = session.lastOffers[Number(idxNum[1])-1];
            } else {
              chosen = session.lastOffers.find(c => new RegExp(c.brand_model||'', 'i').test(text) || new RegExp(c.model||'', 'i').test(text));
            }

            if (isMorePhotos(text) && session.selected) {
              const imgs = carImages(session.selected);
              if (imgs.length) {
                await sendTypingOn(senderId);
                // Try gallery first
                const elements = imgs.map(u => ({ title: session.selected.brand_model || session.selected.model || 'Vehicle', image_url: u }));
                const ok = await sendGenericTemplate(senderId, elements.slice(0,10));
                if (!ok) {
                  for (const url of imgs) await sendImage(senderId, url);
                }
                await sendTypingOff(senderId);
              } else {
                await sendText(senderId, "Wala pang full set ng photos for this unit. I’ll request more from the dealer. 🙂");
              }
              continue;
            }
            if (isShowOthers(text)) {
              // show the next 2 (if any were fetched)
              const next2 = session.lastOffers.slice(2,4);
              if (next2.length) {
                await showTopTwo(senderId, next2, 'Other options na swak din:');
                session.lastOffers = next2; // update window
                session.selected = null;
              } else {
                await sendText(senderId, "Sige! Maghahanap pa ako ng ibang options and I’ll message you. 🙂");
              }
              continue;
            }
            if (isSchedule(text)) {
              await sendText(senderId, "Great! I’ll coordinate the viewing schedule. Pakisend ng **contact number** mo at preferred day/time. 📅");
              continue;
            }

            if (chosen) {
              session.selected = chosen;
              await sendText(senderId, buildCaption(chosen));
              await sendQuickReplies(senderId, "Gusto mo bang makita ang **full photos** o **i-schedule** natin ang viewing?", [
                {title:'View full photos', payload:'MORE_PHOTOS'},
                {title:'Schedule viewing', payload:'SCHEDULE_VIEWING'},
                {title:'Show other options', payload:'SHOW_OTHERS'}
              ]);
              continue;
            }
          }

          // Otherwise we’re in qualifying
          const col = session.collected;
          const hints = detectHints(text);

          // Apply hints
          col.payment      = col.payment      || hints.payment || col.payment;
          col.body_type    = col.body_type    || hints.body_type || col.body_type;
          col.transmission = col.transmission || hints.transmission || col.transmission;
          col.brand        = col.brand        || hints.brand || col.brand;
          col.model        = col.model        || hints.model || col.model;
          col.year         = col.year         || hints.year  || col.year;
          if (hints.budget_cash && col.payment === 'cash' && !col.budget_cash) col.budget_cash = hints.budget_cash;

          // Step-by-step prompts
          const need = stillNeeds({
            payment: col.payment,
            location: col.location,
            body_type: col.body_type,
            transmission: col.transmission,
            budget_cash: col.budget_cash,
            budget_allin: col.budget_allin,
            model: col.model,
            brand: col.brand
          });

          if (need === 'payment') {
            await sendQuickReplies(senderId, "Una: Cash ba o Financing ang plan mo? 🙂", [
              {title:'Cash', payload:'PAYMENT_CASH'},
              {title:'Financing', payload:'PAYMENT_FINANCING'}
            ]);
            continue;
          }
          if (!col.location) {
            col.location = normalizeText(text); // treat the last user message as location if not recognized elsewhere
            if (!col.location || col.location.length < 2) {
              await sendText(senderId, "Saan location ninyo? (city/province)");
              continue;
            } else {
              await sendText(senderId, `Got it, location: ${col.location} ✅`);
            }
          }
          if (!col.body_type && !(col.model || col.brand)) {
            await sendQuickReplies(senderId, "Body type preferred? (pwede ring 'any')", [
              {title:'Sedan', payload:'BODY_SEDAN'},
              {title:'SUV', payload:'BODY_SUV'},
              {title:'MPV', payload:'BODY_MPV'},
              {title:'Van', payload:'BODY_VAN'},
              {title:'Pickup', payload:'BODY_PICKUP'},
              {title:'Any', payload:'BODY_ANY'}
            ]);
            continue;
          }
          if (!col.transmission && !col.model) {
            await sendQuickReplies(senderId, "Transmission?", [
              {title:'Automatic', payload:'TRANS_AUTO'},
              {title:'Manual', payload:'TRANS_MANUAL'},
              {title:'Any', payload:'TRANS_ANY'}
            ]);
            continue;
          }
          if (col.payment === 'cash' && !col.budget_cash) {
            await sendText(senderId, "Magkano ang **budget range** mo (cash)? Hal: ₱450k to ₱600k, or 'below 700k'.");
            continue;
          }
          if (col.payment === 'financing' && !col.budget_allin) {
            await sendText(senderId, "Magkano ang **ready cash-out** / all-in budget mo? Hal: ₱100k to ₱150k.");
            continue;
          }

          // All set → search
          await sendText(senderId, "GOT IT! ✅ I now have everything I need. I can now search available units for you.");
          session.phase = 'offer';

          // Build query to API
          const apiParams = {
            payment: col.payment,
            location: col.location,
            body_type: col.body_type || null,
            transmission: col.transmission || null,
            budget_cash_min: col.budget_cash?.min || null,
            budget_cash_max: col.budget_cash?.max || null,
            budget_allin_min: col.budget_allin?.min || null,
            budget_allin_max: col.budget_allin?.max || null,
            brand: col.brand || null,
            model: col.model || null,
            year:  col.year  || null
          };

          await sendTypingOn(senderId);
          let cars = [];
          try {
            const raw = await fetchInventory(apiParams);
            // score + pick, priority-first but fallback to others if empty
            cars = scoreAndSelect(raw, {
              wanted: 4,
              preferPriority: true,
              body_type: col.body_type,
              transmission: col.transmission,
              model: col.model,
              brand: col.brand,
              payment: col.payment,
              budget_cash: col.budget_cash,
              budget_allin: col.budget_allin
            });
          } catch (e) {
            await sendTypingOff(senderId);
            await sendText(senderId, "Medyo nag-timeout ang inventory. Subukan ko ulit saglit…");
            continue;
          }
          await sendTypingOff(senderId);

          if (!cars.length) {
            await sendText(senderId, "Walang exact match. Okay ba i-expand ng kaunti ang budget o nearby cities para may maipakita ako?");
            continue;
          }

          // Present top 2; Priority first if present (handled inside scoreAndSelect)
          const top2 = cars.slice(0,2);
          session.lastOffers = cars.slice(0,4); // keep a window for “other options”

          await showTopTwo(senderId, top2, "Ito yung best na swak sa details mo (priority muna).");

          // Quick replies with choices
          const qr = top2.map((c,i)=>({title:`${c.year||''} ${c.brand||''} ${c.model||''}`.trim(), payload:`CHOOSE_${i+1}`}));
          qr.push({title:'Show other options', payload:'SHOW_OTHERS'});
          await sendQuickReplies(senderId, "Anong unit ang pipiliin mo?", qr);
          continue;
        }

        // Postbacks / payloads
        if (event.postback && event.postback.payload) {
          const payload = event.postback.payload;
          // (optional) handle here if you add postback buttons
        }

        if (event.message && event.message.quick_reply && event.message.quick_reply.payload) {
          const pl = event.message.quick_reply.payload;
          const session = initSession(senderId);
          const col = session.collected;

          if (pl === 'PAYMENT_CASH')       col.payment = 'cash';
          if (pl === 'PAYMENT_FINANCING')  col.payment = 'financing';
          if (pl === 'BODY_SEDAN')         col.body_type = 'sedan';
          if (pl === 'BODY_SUV')           col.body_type = 'suv';
          if (pl === 'BODY_MPV')           col.body_type = 'mpv';
          if (pl === 'BODY_VAN')           col.body_type = 'van';
          if (pl === 'BODY_PICKUP')        col.body_type = 'pickup';
          if (pl === 'BODY_ANY')           col.body_type = 'any';
          if (pl === 'TRANS_AUTO')         col.transmission = 'automatic';
          if (pl === 'TRANS_MANUAL')       col.transmission = 'manual';
          if (pl === 'TRANS_ANY')          col.transmission = 'any';

          if (/^CHOOSE_[12]$/.test(pl)) {
            const idx = Number(pl.split('_')[1]) - 1;
            const chosen = session.lastOffers[idx];
            if (chosen) {
              session.selected = chosen;
              await sendText(senderId, buildCaption(chosen));
              await sendQuickReplies(senderId, "Gusto mo bang makita ang **full photos** o **i-schedule** natin ang viewing?", [
                {title:'View full photos', payload:'MORE_PHOTOS'},
                {title:'Schedule viewing', payload:'SCHEDULE_VIEWING'},
                {title:'Show other options', payload:'SHOW_OTHERS'}
              ]);
              return res.status(200).send('OK');
            }
          }
          if (pl === 'MORE_PHOTOS') {
            if (session.selected) {
              const imgs = carImages(session.selected);
              if (imgs.length) {
                await sendTypingOn(senderId);
                const elements = imgs.map(u => ({ title: session.selected.brand_model || session.selected.model || 'Vehicle', image_url: u }));
                const ok = await sendGenericTemplate(senderId, elements.slice(0,10));
                if (!ok) {
                  for (const url of imgs) await sendImage(senderId, url);
                }
                await sendTypingOff(senderId);
              } else {
                await sendText(senderId, "Wala pang full set ng photos for this unit. I’ll request more from the dealer. 🙂");
              }
            } else {
              await sendText(senderId, "Please pick a unit first. 🙂");
            }
          }
          if (pl === 'SCHEDULE_VIEWING') {
            await sendText(senderId, "Great! I’ll coordinate the viewing schedule. Pakisend ng **contact number** mo at preferred day/time. 📅");
          }
          if (pl === 'SHOW_OTHERS') {
            const next2 = session.lastOffers.slice(2,4);
            if (next2.length) {
              await showTopTwo(senderId, next2, 'Other options na swak din:');
              session.lastOffers = next2;
              session.selected = null;
            } else {
              await sendText(senderId, "Sige! Maghahanap pa ako ng ibang options and I’ll message you. 🙂");
            }
          }

          return res.status(200).send('OK');
        }
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).send('webhook error');
  }
}

// ----- presenters -----
async function showTopTwo(senderId, cars, introText) {
  await sendText(senderId, introText);

  // Try gallery first (two cards)
  const elements = cars.map(c => ({
    title: `${c.year||''} ${c.brand||''} ${c.model||''}`.trim(),
    subtitle: buildCaption(c).split('\n').slice(1).join(' • '),
    image_url: carImages(c)[0] || c.image_1 || null,
    buttons: [
      { type: 'postback', title: 'View full photos', payload: 'MORE_PHOTOS' },
      { type: 'postback', title: 'Schedule viewing', payload: 'SCHEDULE_VIEWING' }
    ]
  }));
  const galleryOk = await sendGenericTemplate(senderId, elements);

  if (!galleryOk) {
    // Fallback: stacked image + caption
    for (const c of cars) {
      const img = carImages(c)[0];
      if (img) await sendImage(senderId, img);
      await sendText(senderId, buildCaption(c));
    }
  }
}
