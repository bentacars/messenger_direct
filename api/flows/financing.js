import { sameDayAllowed, captureScheduleFromText, summarizeProposed, needsSchedule } from '../lib/schedule.js';
import { needsContact, missingContactField, tryCaptureMobile, tryCaptureName } from '../lib/contact.js';
import { resolveAddressByChosen } from '../lib/address.js';
import { ensureDocsStore, markDocsReceived, detectDocsFromAttachments } from '../lib/docs.js';
import { sendText } from '../lib/messenger.js';
import { cashLine, financingLine, monthlyLines } from '../lib/pricing.js';

function incomeAsked(session) {
  return Boolean(session.fin?.source);
}

function ensureFinStore(session) {
  if (!session.fin) session.fin = { source: null, term: null };
}

export async function finEntry(psid, session) {
  session.phase = 'p3_fin';

  // Scheduling first
  if (needsSchedule(session)) {
    if (sameDayAllowed()) {
      await sendText(psid, "Available ka ba today for quick unit viewing? If not, anong day/time ka pwede?");
    } else {
      await sendText(psid, "Medyo late na for same-day viewing. What day/time works for you tomorrow (or next available day)?");
    }
    return;
  }

  // Continue to contact step
  await finContactStep(psid, session);
}

export async function finHandle(psid, session, userText, attachments) {
  // Step 1: Schedule
  if (needsSchedule(session)) {
    if (captureScheduleFromText(session, userText)) {
      await sendText(psid, summarizeProposed(session.schedule.when));
    } else {
      await sendText(psid, "Anong day at time ka pwede for viewing? (e.g., “Wed 3pm”, “Saturday morning”)");
      return;
    }
  }

  // Step 2: Contact gate
  if (await finContactStep(psid, session)) return;

  // Step 3: Income source + terms + computed lines
  if (!incomeAsked(session)) {
    await sendText(psid, "While I’m locking your slot — since financing, ano ang source of income mo? (Employed / Business / OFW / Seaman / Pension / Other)");
    return;
  }

  // If income already asked, see if the user provided one now
  const low = userText.toLowerCase();
  ensureFinStore(session);
  if (!session.fin.source) {
    if (/employ|sahod|worker|job/.test(low)) session.fin.source = 'employed';
    else if (/business|self\-?employed|negosyo/.test(low)) session.fin.source = 'business';
    else if (/ofw|seaman|seafarer/.test(low)) session.fin.source = 'ofw/seaman';
    else if (/pension/.test(low)) session.fin.source = 'pension';
    else if (/other|iba/.test(low)) session.fin.source = 'other';
  }

  // Show financing lines (all-in bracket + monthly)
  if (!session._finLinesShown) {
    const u = session?.chosen?.unit;
    const lines = [
      financingLine(u),
      monthlyLines(u)
    ].filter(Boolean).join('\n');
    if (lines) await sendText(psid, `Estimated only:\n${lines}\nIlang years mo planong hulugan? (2, 3, or 4 years)`);
    session._finLinesShown = true;
    return;
  }

  // Capture preferred term
  if (!session.fin.term) {
    const n = Number((userText.match(/\b[234]\b/)||[])[0] || 0);
    if (n) {
      session.fin.term = n;
    } else {
      await sendText(psid, "Sige. Paki-indicate kung 2, 3, o 4 years yung preferred mo.");
      return;
    }
  }

  // Ask docs based on source
  ensureFinStore(session);
  ensureDocsStore(session);

  if (!session._docsAsked) {
    switch (session.fin.source) {
      case 'employed':
        await sendText(psid, "Employed — may ready ka bang COE or latest payslip? Pwede mong i-send dito (photo or PDF).");
        break;
      case 'business':
        await sendText(psid, "Business — may DTI/Mayor’s Permit ka? Send mo kasama ng latest income proof (bank statement or receipts).");
        break;
      case 'ofw/seaman':
        await sendText(psid, "OFW/Seaman — ikaw ba mismo o receiver ng remittance? Valid ID + contract or remittance slip will help. Send mo dito.");
        break;
      case 'pension':
        await sendText(psid, "Pension — send mo valid ID + latest pension proof. Photo/PDF ok.");
        break;
      default:
        await sendText(psid, "Send mo muna any valid ID + proof of income (photo/PDF). We can pre-approve after checking.");
        break;
    }
    session._docsAsked = true;
    return;
  }

  // Detect docs from attachments (image/file)
  if (detectDocsFromAttachments(attachments)) {
    markDocsReceived(session);
    await sendText(psid, "Got it ✅ Reviewing now. Expect a call so we can fast-track approval.");
    session.phase = 'done_fin';
    return;
  }

  // If still nothing, gently remind
  await sendText(psid, "Sige lang, send mo lang yung basic docs dito pag ready ka na. 👍");
}

async function finContactStep(psid, session) {
  if (needsContact(session)) {
    const missing = missingContactField(session);
    if (missing === 'mobile') {
      await sendText(psid, "Para ma-lock ko yung schedule, paki-send ng mobile number mo (PH format).");
      return true;
    }
    if (missing === 'fullname') {
      await sendText(psid, "Noted. Paki-send ng full name mo rin (first & last).");
      return true;
    }
  }

  // Reveal unit address after contact
  const addr = await resolveAddressByChosen(session);
  if (addr && !session._addrShown) {
    await sendText(psid, `Complete address of the unit:\n${addr}\n\nSee you on your schedule! If may changes, message mo lang ako.`);
    session._addrShown = true;
  }
  return false;
}

// Guard if user asks address too early
export async function finAddressGate(psid) {
  await sendText(psid, "Ibibigay ko ang full address once ma-lock natin ang viewing schedule + contact details mo. Para ma-prepare yung unit at ma-assist ka ng team.");
}

// Attempt to capture contact from free text
export function finTryCaptureContact(session, userText) {
  if (!session?.contact?.mobile && tryCaptureMobile(session, userText)) return 'mobile';
  if (session?.contact?.mobile && !session?.contact?.fullname && tryCaptureName(session, userText)) return 'fullname';
  return null;
}
