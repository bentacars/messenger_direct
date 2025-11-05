// server/flows/financing.js
import { sendText } from '../lib/messenger.js';

export async function financingFlow({ psid, state, text }) {
  // Reuse the same schedule flow as cash until contact is gathered
  if (!state.schedule_time || !state.mobile) {
    return await import('./cash.js').then(m => m.cashFlow({ psid, state, text }));
  }

  // Then financing Qs
  if (!state.income_type) {
    await sendText(psid, "Since financing—ano po ang source of income ninyo? Employed? Business? OFW / Seaman?");
    state.income_type = 'asked';
    return;
  }
  if (state.income_type === 'asked') {
    state.income_type = text.toLowerCase();
    // Send quick estimate template (assumes unit has fields)
    const u = state.chosen_unit || {};
    const est = [
      `All-in est.: ₱${Number(u.all_in || 0).toLocaleString()}`,
      `Monthly est.: 2yrs/3yrs/4yrs depende sa approval.`,
      `Note: Estimated lang—final depends sa docs.`
    ].join('\n');
    await sendText(psid, est);
    await sendText(psid, "Ilang years nyo balak hulugan?");
    state.term_asked = true;
    return;
  }
  if (state.term_asked && !state.term) {
    state.term = text;
  }

  // Requirements per income type
  const it = state.income_type;
  if (/employ/i.test(it)) {
    await sendText(psid, "Employed—may COE na ba kayo or magrerequest pa lang? Pwede nyo isend dito payslip or COE + valid ID anytime para ma-start pre-approval.");
  } else if (/business|self/i.test(it)) {
    await sendText(psid, "Business owner—ano nature ng business? Send DTI/permit + 3-month income proof (bank statement/receipts) + valid ID para ma-pre-approve.");
  } else if (/ofw|seaman|seafar/i.test(it)) {
    await sendText(psid, "Kung ikaw mismo ang OFW/Seaman: passport/seaman book + contract + remittance proof + valid ID.\nKung receiver ka lang: remittance proof + valid ID.");
  } else {
    await sendText(psid, "Pwede natin i-assess once may basic ID or income proof ka. Send mo lang dito para ma-pre-screen.");
  }

  state.status = 'in progress - financing';
}
