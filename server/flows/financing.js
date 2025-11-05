// /server/flows/financing.js
// Phase 3B: Financing path (schedule → contact → income → docs → done)

export async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = getPayload(rawEvent);
  const t = String(userText || '').trim();

  session.funnel = session.funnel || {};
  session.funnel.fin = session.funnel.fin || {};
  if (!session.finStep) session.finStep = 'schedule';

  // 1) Schedule (for appraisal / viewing)
  if (session.finStep === 'schedule') {
    if (t && !payload) {
      session.funnel.fin.schedule = t;
      session.finStep = 'contact';
    } else {
      messages.push({
        type: 'buttons',
        text: 'Kailan ka free for unit viewing (for appraisal)?',
        buttons: [
          { title: 'Today', payload: 'VIEW_TODAY' },
          { title: 'Tomorrow', payload: 'VIEW_TOMORROW' },
          { title: 'Pick a date', payload: 'VIEW_PICK' },
        ],
      });
      if (payload === 'VIEW_TODAY') {
        session.funnel.fin.schedule = 'Today';
        session.finStep = 'contact';
      } else if (payload === 'VIEW_TOMORROW') {
        session.funnel.fin.schedule = 'Tomorrow';
        session.finStep = 'contact';
      } else if (payload === 'VIEW_PICK') {
        messages.push({ type: 'text', text: 'Type mo preferred date/time (e.g., “Nov 7 3PM”).' });
      }
      if (messages.length) return { session, messages };
    }
  }

  // 2) Contact number
  if (session.finStep === 'contact') {
    const phone = extractPhone(t);
    if (phone) {
      session.funnel.fin.phone = phone;
      session.finStep = 'income';
    } else {
      messages.push({ type: 'text', text: 'Contact number mo po? Ipapadala ko rin ang checklist. 📩' });
      return { session, messages };
    }
  }

  // 3) Income selection
  if (session.finStep === 'income') {
    // Payload choice or text
    if (!payload && !/employ|self|ofw|seafarer/i.test(t)) {
      messages.push({
        type: 'buttons',
        text: 'Source of income?',
        buttons: [
          { title: 'Employed', payload: 'INC_EMPLOYED' },
          { title: 'Self-employed', payload: 'INC_SELF' },
          { title: 'OFW/Seafarer', payload: 'INC_OFW' },
        ],
      });
      return { session, messages };
    }

    let kind = '';
    if (payload === 'INC_EMPLOYED' || /employ/i.test(t)) kind = 'employed';
    else if (payload === 'INC_SELF' || /self/i.test(t)) kind = 'self';
    else if (payload === 'INC_OFW' || /ofw|seafarer/i.test(t)) kind = 'ofw';
    else kind = 'employed';

    session.funnel.fin.income = kind;
    session.finStep = 'docs';
  }

  // 4) Docs checklist per income type
  if (session.finStep === 'docs') {
    const inc = session.funnel.fin.income || 'employed';
    const req = getChecklist(inc);
    session.funnel.fin.requiredDocs = req;

    messages.push({
      type: 'text',
      text:
`Okay. ✅ Since you’re **${labelIncome(inc)}**, here’s the usual checklist:
${req.map((x, i) => `${i + 1}. ${x}`).join('\n')}

Pwede mong i-upload dito or reply “Send later” para i-follow up ko.`
    });

    // quick replies for convenience
    messages.push({
      type: 'quick_replies',
      text: 'Ready ka na ba mag-upload?',
      replies: [
        { title: 'I’ll send later', payload: 'DOCS_LATER' },
        { title: 'I’ll upload here', payload: 'DOCS_UPLOAD' },
      ],
    });

    session.finStep = 'done';
    return { session, messages };
  }

  // 5) Done / Summary
  const sum = summarizeFin(session);
  messages.push({ type: 'text', text: `All set. ✅ ${sum}\nHintayin mo ang follow-up for requirements & approval timeline.` });
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

function getChecklist(kind) {
  switch (kind) {
    case 'employed':
      return [
        'Valid IDs (2 government IDs)',
        'COE (with salary) or Latest Contract',
        'Payslips (last 3 months)',
        'Proof of billing (address)',
        'Bank statement (3–6 months, if available)',
      ];
    case 'self':
      return [
        'Valid IDs (2 government IDs)',
        'DTI/SEC & Mayor’s Permit',
        'Latest ITR / Audited FS (if any)',
        'Bank statement (6 months)',
        'Proof of billing (business/home)',
      ];
    case 'ofw':
      return [
        'Valid IDs (2 government IDs)',
        'Passport & Seaman’s Book (if seafarer)',
        'OEC/Contract/POEA docs',
        'Proof of remittance (3–6 months)',
        'Proof of billing (home)',
      ];
    default:
      return ['Valid IDs', 'Proof of income', 'Proof of billing'];
  }
}

function labelIncome(k) {
  if (k === 'employed') return 'Employed';
  if (k === 'self') return 'Self-employed';
  if (k === 'ofw') return 'OFW/Seafarer';
  return 'Applicant';
}

function summarizeFin(session) {
  const unit = session?.funnel?.unit?.label || 'Selected unit';
  const fin = session?.funnel?.fin || {};
  const parts = [];
  if (fin.schedule) parts.push(`Viewing: ${fin.schedule}`);
  if (fin.phone) parts.push(`Contact: ${fin.phone}`);
  if (fin.income) parts.push(`Income: ${labelIncome(fin.income)}`);
  if (Array.isArray(fin.requiredDocs)) parts.push(`Docs: ${fin.requiredDocs.length} items`);
  return `${unit}. ${parts.join(' • ')}`;
}
