// /server/flows/cash.js
// Phase 3A: Cash path (schedule → contact → address → done)

export async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = getPayload(rawEvent);
  const t = String(userText || '').trim();

  session.funnel = session.funnel || {};
  session.funnel.cash = session.funnel.cash || {};
  if (!session.cashStep) session.cashStep = 'schedule';

  // 1) Schedule
  if (session.cashStep === 'schedule') {
    // If user already answered with a rough date/time via text, store it
    if (t && !payload) {
      session.funnel.cash.schedule = t;
      session.cashStep = 'contact';
    } else {
      messages.push({
        type: 'buttons',
        text: 'Kailan ka free for unit viewing?',
        buttons: [
          { title: 'Today', payload: 'VIEW_TODAY' },
          { title: 'Tomorrow', payload: 'VIEW_TOMORROW' },
          { title: 'Pick a date', payload: 'VIEW_PICK' },
        ],
      });
      if (payload === 'VIEW_TODAY') {
        session.funnel.cash.schedule = 'Today';
        session.cashStep = 'contact';
      } else if (payload === 'VIEW_TOMORROW') {
        session.funnel.cash.schedule = 'Tomorrow';
        session.cashStep = 'contact';
      } else if (payload === 'VIEW_PICK') {
        messages.push({ type: 'text', text: 'Type mo preferred date/time (e.g., “Nov 7 3PM”).' });
      }
      if (messages.length) return { session, messages };
    }
  }

  // 2) Contact number
  if (session.cashStep === 'contact') {
    const phone = extractPhone(t);
    if (phone) {
      session.funnel.cash.phone = phone;
      session.cashStep = 'address';
    } else {
      messages.push({ type: 'text', text: 'Pakibigay mobile number para ma-confirm ko ang schedule. 🙏' });
      return { session, messages };
    }
  }

  // 3) Address / City
  if (session.cashStep === 'address') {
    if (t) {
      session.funnel.cash.city = t;
      session.cashStep = 'done';
    } else {
      messages.push({ type: 'text', text: 'Saan city ka manggagaling? Para ma-suggest ko ang nearest branch/showroom.' });
      return { session, messages };
    }
  }

  // 4) Done / Summary
  const sum = summarizeCash(session);
  messages.push({ type: 'text', text: `Got it. ✅ ${sum}` });
  return { session, messages };
}

/* ---------------- helpers ---------------- */
function getPayload(evt) {
  const p = evt?.postback?.payload;
  return typeof p === 'string' ? p : '';
}

function extractPhone(s = '') {
  const m = s.replace(/\s+/g, '').match(/(\+?63|0)9\d{9}/);
  return m ? normalizePH(m[0]) : '';
}

function normalizePH(p = '') {
  let x = p.replace(/\D/g, '');
  if (x.startsWith('09')) return '+63' + x.slice(1);
  if (x.startsWith('9') && x.length === 10) return '+63' + x;
  if (x.startsWith('63') && x.length === 12) return '+' + x;
  if (x.startsWith('+63') && x.length === 13) return x;
  return p;
}

function summarizeCash(session) {
  const unit = session?.funnel?.unit?.label || 'Selected unit';
  const s = session?.funnel?.cash || {};
  const parts = [];
  if (s.schedule) parts.push(`Viewing: ${s.schedule}`);
  if (s.phone) parts.push(`Contact: ${s.phone}`);
  if (s.city) parts.push(`City: ${s.city}`);
  return `${unit}. ${parts.join(' • ')}`;
}
