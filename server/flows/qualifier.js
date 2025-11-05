// server/flows/qualifier.js
import { extractQual, nlgTone } from '../lib/ai.js';
import { BODY_TYPES, TRANS } from '../constants.js';

const normalize = (s='') => (s || '').toString().trim().toLowerCase();

function mergeSession(session, patch) {
  session.qualifier = session.qualifier || {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null || v === undefined || v === '') continue;
    session.qualifier[k] = v;
  }
}

function isComplete(q) {
  return !!(q.payment && q.budget_number && q.location_city && q.transmission && q.body_type);
}

function humanSummary(q, name) {
  const who = name ? `${name}, ` : '';
  const pay = q.payment === 'financing' ? 'Financing' : 'Cash';
  const trans = q.transmission?.toUpperCase();
  const bt = q.body_type?.toUpperCase();
  const pref = [q.pref_brand, q.pref_model, q.pref_variant, q.pref_year].filter(Boolean).join(' ');
  const prefLine = pref ? `\n• Pref: ${pref}` : '';
  return `${who}ito’ng haharapin ko for you:
• ${pay}
• Budget ~ ₱${Number(q.budget_number).toLocaleString()}
• Location: ${q.location_city}
• Trans: ${trans}
• Body: ${bt}${prefLine}
Saglit, I’ll pull the best units that fit this. 🔎`;
}

export default {
  async step(session, userText, raw) {
    session.history = session.history || [];
    // Append user turn
    session.history.push({ role: 'user', content: userText });

    // Extract/merge qualifiers
    const parsed = await extractQual({ history: session.history });
    const patch = {};

    // Normalize fields
    if (parsed.payment) {
      patch.payment = normalize(parsed.payment).includes('financ') || normalize(parsed.payment).includes('hulug') ? 'financing' : 'cash';
    }
    if (parsed.budget_number) patch.budget_number = parseInt(parsed.budget_number, 10);
    if (parsed.location_city) patch.location_city = parsed.location_city.trim();
    if (parsed.transmission) {
      let t = normalize(parsed.transmission);
      if (t === 'at') t = 'automatic';
      if (t === 'mt') t = 'manual';
      if (!TRANS.includes(t)) t = 'any';
      patch.transmission = t;
    }
    if (parsed.body_type) {
      let b = normalize(parsed.body_type);
      if (!BODY_TYPES.includes(b)) b = 'any';
      patch.body_type = b;
    }
    // preferences
    patch.pref_brand = parsed.pref_brand || session.qualifier?.pref_brand || null;
    patch.pref_model = parsed.pref_model || session.qualifier?.pref_model || null;
    patch.pref_year = parsed.pref_year || session.qualifier?.pref_year || null;
    patch.pref_variant = parsed.pref_variant || session.qualifier?.pref_variant || null;

    mergeSession(session, patch);

    // Decide next message
    if (!isComplete(session.qualifier)) {
      // Ask *only* the missing items in a human way using NLG
      const missing = [];
      if (!session.qualifier.payment) missing.push('payment (cash o hulugan)');
      if (!session.qualifier.budget_number) missing.push('budget');
      if (!session.qualifier.location_city) missing.push('location (city/province)');
      if (!session.qualifier.transmission) missing.push('transmission (AT/MT/any)');
      if (!session.qualifier.body_type) missing.push('body type (sedan/suv/mpv/van/pickup/hatchback/crossover/any)');

      const sysRecap = Object.entries(session.qualifier)
        .filter(([,v]) => v)
        .map(([k,v]) => `${k}: ${v}`)
        .join(', ');

      const prompt = [
        { role: 'system', content: `So far we have: ${sysRecap || 'none yet'}. Ask for ONLY the missing info: ${missing.join(', ')}. Keep it short, Taglish, friendly.`}
      ];
      const reply = await nlgTone({ history: prompt.concat(session.history), session });
      session.history.push({ role: 'assistant', content: reply });
      return { done: false, message: reply };
    }

    // Complete — provide human summary to transition to offers
    const reply = humanSummary(session.qualifier, session.name);
    session.history.push({ role: 'assistant', content: reply });
    return { done: true, message: reply };
  }
};
