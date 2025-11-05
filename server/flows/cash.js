// server/flows/cash.js
import { sendText } from '../lib/messenger.js';
import rules from '../config/rules.json' assert { type: 'json' };

export async function cashFlow({ psid, state, text }) {
  // Scheduling first (time rules)
  const now = new Date();
  const tz = rules.quiet_hours.tz || 'Asia/Manila';
  const hour = Number(new Intl.DateTimeFormat('en-PH',{ timeZone: tz, hour:'2-digit', hour12:false }).format(now));

  if (!state._asked_schedule) {
    state._asked_schedule = true;
    const offer = hour <= 15 ? 'Today or Tomorrow' : 'Tomorrow (or pick a date)';
    await sendText(psid, `Available ka ba for unit viewing? Mas mabilis mag-decide pag nakita mo mismo. (Options: ${offer})`);
    return;
  }

  if (!state.schedule_day) {
    state.schedule_day = text;
    await sendText(psid, "Anong oras prefer mo?");
    return;
  }

  if (!state.schedule_time) {
    state.schedule_time = text;
    await sendText(psid, "Para ma-confirm ko ang slot at ma-prepare ang unit, paki-send ng full name + mobile number (required by showroom).");
    return;
  }

  if (!state.full_name || !state.mobile) {
    // Try to parse "Name, 09xxxxxxxxx"
    const m = text.match(/^(.*?)[,\s]+(\+?63|0)\d{9,10}$/i);
    if (m) {
      state.full_name = m[1].trim();
      state.mobile = m[2] ? m[0].slice(m[1].length).trim().replace(/^[,\s]+/, '') : '';
    } else if (/^\+?63|0\d{9,10}$/i.test(text)) {
      state.mobile = text.trim();
    } else {
      state.full_name = state.full_name || text.trim();
      if (!state.mobile) {
        await sendText(psid, "Paki-send din po yung mobile number (09xxxxxxxxx or +639xxxxxxxxx).");
        return;
      }
    }
  }

  if (!state.full_name || !state.mobile) return;

  // Address reveal
  const u = state.chosen_unit || {};
  const addr = [u.complete_address, u.city, u.province].filter(Boolean).join(', ');
  await sendText(psid, `✅ Got it! Your viewing is confirmed.\nLocation: ${addr}\nMessage mo lang ako if you need directions ha.`);
  state.status = 'scheduled - cash';
}
