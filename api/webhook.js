// /api/webhook.js
// Messenger direct webhook with 2-offer quick replies flow

// ENV
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // not used in this snippet, kept for future
const INVENTORY_API_URL = process.env.INVENTORY_API_URL;

// Memory (ephemeral)
const sessions = new Map(); // senderId -> { context, lastMatches, lastSelectedSku }

import { sendText, sendQuickReplies, sendImage, sendMultiImages, sendButtons } from './lib/messenger.js';
import { fetchInventory, pickTopTwo, unitBlurb, imagesOf } from './lib/matching.js';

// ---- helpers ----
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { context: {}, lastMatches: [], lastSelectedSku: null });
  return sessions.get(id);
}

function wantsMorePhotos(text = '') {
  const t = text.toLowerCase();
  return /(more (photo|pic)|pictures?|show (more|all) (photo|pic)s?)/i.test(t) || t === 'more photos';
}

function parsePostback(payload = '') {
  try { return JSON.parse(payload); } catch { return { type: payload }; }
}

// ---- GET verify ----
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ---- POST events ----
export async function POST(req) {
  try {
    const body = await req.json();

    if (body.object !== 'page' || !body.entry) {
      return new Response('ignored', { status: 200 });
    }

    for (const entry of body.entry) {
      for (const evt of entry.messaging || []) {
        const senderId = evt.sender && evt.sender.id;
        if (!senderId) continue;
        const S = getSession(senderId);

        // Quick reply / postback payloads
        if (evt.message && evt.message.quick_reply && evt.message.quick_reply.payload) {
          const p = parsePostback(evt.message.quick_reply.payload);
          if (p.type === 'SELECT_UNIT' && p.sku) {
            S.lastSelectedSku = p.sku;
            const chosen = (S.lastMatches || []).find(u => String(u.SKU) === String(p.sku));
            if (chosen) {
              // full photos
              await sendText(PAGE_TOKEN, senderId, `✅ Selected: ${unitBlurb(chosen)}\n\nSending photos…`);
              const imgs = imagesOf(chosen);
              await sendMultiImages(PAGE_TOKEN, senderId, imgs);
              await sendQuickReplies(PAGE_TOKEN, senderId, 'Gusto mo bang i-schedule ang viewing?', [
                { title: 'Schedule viewing', payload: JSON.stringify({ type: 'SCHEDULE', sku: p.sku }) },
                { title: 'Show other units', payload: JSON.stringify({ type: 'SHOW_OTHERS' }) },
              ]);
            } else {
              await sendText(PAGE_TOKEN, senderId, 'Sorry, di ko mahanap yung unit. Try ulit natin.');
            }
            continue;
          }

          if (p.type === 'SHOW_OTHERS') {
            // fall back to search again without strict model
            await handleSearchAndOffer(senderId, S, { relax: true });
            continue;
          }
        }

        if (evt.postback && evt.postback.payload) {
          const p = parsePostback(evt.postback.payload);
          if (p.type === 'SCHEDULE' && p.sku) {
            await sendText(PAGE_TOKEN, senderId, 'Great! Iche-check ko ang availability and ibibigay ko ang schedule options. ✨');
            continue;
          }
        }

        // Regular message text
        if (evt.message && evt.message.text) {
          const text = evt.message.text.trim();

          // "more photos"
          if (wantsMorePhotos(text)) {
            if (S.lastSelectedSku) {
              const chosen = (S.lastMatches || []).find(u => String(u.SKU) === String(S.lastSelectedSku));
              if (chosen) {
                await sendMultiImages(PAGE_TOKEN, senderId, imagesOf(chosen));
              } else {
                await sendText(PAGE_TOKEN, senderId, 'Send ka muna ng model or pili ka ng unit para masend ko ang photos.');
              }
            } else {
              await sendText(PAGE_TOKEN, senderId, 'Send ka muna ng model or pili ka ng unit para masend ko ang photos.');
            }
            continue;
          }

          // Minimal intent extraction: look for a model keyword; store context
          // (Qualifier logic you already have can fill S.context; here we only read model/brand if present)
          const maybeModel = text.match(/([A-Za-z0-9]+)\s*(mirage|vios|city|innova|fortuner|hiace|stargazer|brio|wigo|almera|terra|navara|accent|elantra|civic|crv|jazz|cx-5|cx5|mazda|toyota|honda|mitsubishi|nissan)/i);
          if (!S.context.model && maybeModel) {
            S.context.model = text; // keep raw; scoring handles includes()
          }

          await handleSearchAndOffer(senderId, S, {});
        }
      }
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('webhook error', err);
    return new Response('error', { status: 500 });
  }
}

// ---- core: search + 2-offer quick replies ----
async function handleSearchAndOffer(senderId, S, { relax = false } = {}) {
  // Build a light query for your Apps Script (it can ignore unknown fields)
  const query = {
    model: S.context.model || '',                // e.g., "Mirage"
    brand: S.context.brand || '',
    body_type: S.context.body_type || '',
    transmission: S.context.transmission || '',
    mode: S.context.mode || '',                  // 'cash' | 'financing'
    budget: S.context.budget || '',
    cash_on_hand: S.context.cash_on_hand || '',
    city: S.context.city || '',
    relax
  };

  // Fetch & pick
  const items = await fetchInventory(INVENTORY_API_URL, query);
  const top2 = pickTopTwo(items, query);

  if (!top2.length) {
    await sendText(PAGE_TOKEN, senderId, 'Wala pang exact match. Pwede nating i-expand nang konti ang budget or ibang nearby city para may maipakita ako. 🙂');
    S.lastMatches = [];
    return;
  }

  // Save in session to resolve selections later
  S.lastMatches = top2;

  // Send intro + first unit’s image_1 and quick replies
  const first = top2[0];
  const second = top2[1];

  await sendText(PAGE_TOKEN, senderId, 'Ito yung best na swak sa details mo (priority muna).');

  // First unit lead image (image_1) + blurb
  const img1 = (first.image_1 || '').trim();
  if (img1) await sendImage(PAGE_TOKEN, senderId, img1);
  await sendText(PAGE_TOKEN, senderId, `🚗 ${unitBlurb(first)}`);

  // Prepare quick replies
  const replies = [
    { title: trimTitle(first), payload: JSON.stringify({ type: 'SELECT_UNIT', sku: String(first.SKU) }) },
  ];
  if (second) {
    const img2 = (second.image_1 || '').trim();
    if (img2) await sendImage(PAGE_TOKEN, senderId, img2);
    await sendText(PAGE_TOKEN, senderId, `🚗 ${unitBlurb(second)}`);
    replies.push({ title: trimTitle(second), payload: JSON.stringify({ type: 'SELECT_UNIT', sku: String(second.SKU) }) });
  }
  replies.push({ title: 'Show other units', payload: JSON.stringify({ type: 'SHOW_OTHERS' }) });

  await sendQuickReplies(PAGE_TOKEN, senderId, 'Alin ang pipiliin mo?', replies);
}

function trimTitle(u) {
  // Keep titles short for quick replies
  const model = [u.brand, u.model].filter(Boolean).join(' ');
  const yr = u.year ? String(u.year) : '';
  return `${yr ? yr + ' ' : ''}${model}`.slice(0, 20);
}
