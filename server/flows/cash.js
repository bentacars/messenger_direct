// server/flows/cash.js
import { saveSession } from '../lib/session.js';
import { sendCarousel, sendImage, sendQuick, sendText } from '../lib/messenger.js';
import { unitImages } from './offers.js';
import { PH_TZ, QUIET_END_HOUR, QUIET_START_HOUR } from '../constants.js';

function phNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: PH_TZ })); }
function isSameDayOfferWindow(d=phNow()) {
  const h = d.getHours();
  return h >= 6 && h <= 15; // 6:00–15:00
}

export async function photos({ psid, session, unit }) {
  const imgs = unitImages(unit);
  if (!imgs.length) return sendText(psid, 'No photos available right now.');
  const items = imgs.map((url, i) => ({
    title: i===0 ? 'Photos' : `Photo ${i+1}`,
    image_url: url
  }));
  // Try carousel; fallback to sequential if FB blocks template
  try { await sendCarousel(psid, items.slice(0,10)); }
  catch { for (const url of imgs) await sendImage(psid, url); }
}

export async function start({ psid, session }) {
  // Ask viewing schedule (time-window logic)
  const canToday = isSameDayOfferWindow();
  const line = canToday
    ? 'Available ka ba for unit viewing **today or tomorrow**? Mas mabilis mag-decide pag nakita mo mismo.'
    : 'Skip na muna ang same-day. Available ka ba **tomorrow** or pick a date na ok sa’yo?';
  await sendText(psid, line.replace(/\*\*/g,''));
  session.phase = 'cash';
  session.cash = session.cash || { schedule_locked:false };
  await saveSession(psid, session);
}

export async function onSchedule({ psid, session, userText }) {
  session.cash = session.cash || {};
  // naive capture — you can improve with parser
  if (!session.cash.date) {
    session.cash.date = userText;
    await saveSession(psid, session);
    return sendText(psid, 'Anong preferred time mo? (e.g., 11am / 2:30pm)');
  }
  if (!session.cash.time) {
    session.cash.time = userText;
    session.cash.schedule_locked = true;
    await saveSession(psid, session);
    return sendText(psid, 'Sige, i-lock ko yung slot mo. Before ko ibigay ang full address, paki-send ng **full name + mobile** (required by showroom).');
  }
}

function validMobile(s='') { return /\b(\+?639\d{9}|09\d{9})\b/.test(s); }

export async function onContact({ psid, session, userText }) {
  session.cash = session.cash || {};
  const hasName = !!session.cash.full_name || /[a-z]/i.test(userText||'');
  const hasMobile = validMobile(userText||'');
  if (!hasName && !hasMobile) return sendText(psid, 'Pakisend muna ng **full name + mobile** (e.g., Juan Dela Cruz, 09xxxxxxxxx).');
  if (!session.cash.full_name && hasName) session.cash.full_name = userText.replace(/(\+?639\d{9}|09\d{9})/,'').trim();
  if (!session.cash.mobile && hasMobile) session.cash.mobile = (userText.match(/(\+?639\d{9}|09\d{9})/)||[])[0];
  await saveSession(psid, session);

  if (!session.cash.full_name) return sendText(psid, 'Ano pong full name ninyo?');
  if (!session.cash.mobile) return sendText(psid, 'Pakisend po ng mobile (09xxxxxxxxx or +639xxxxxxxxx).');

  // Unlock address
  const u = session.cash.unit;
  const address = u?.complete_address || `${u?.city||''} ${u?.province||''}`.trim();
  await sendText(psid, '✅ Got it! Your viewing is confirmed. Here’s the full location 👇');
  await sendText(psid, address || 'Address to follow from dealer. Message me if you need directions ha.');
}
