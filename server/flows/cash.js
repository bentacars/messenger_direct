import { sameDayAllowed, captureScheduleFromText, summarizeProposed, needsSchedule } from '../lib/schedule.js';
import { needsContact, missingContactField, tryCaptureMobile, tryCaptureName } from '../lib/contact.js';
import { resolveAddressByChosen } from '../lib/address.js';
import { sendText } from '../lib/messenger.js';

export async function cashEntry(psid, session) {
  // Called right after user picks unit and gallery has been sent
  session.phase = 'p3_cash';

  // Scheduling start
  if (needsSchedule(session)) {
    if (sameDayAllowed()) {
      await sendText(psid, "Available ka ba today for quick viewing? If not, sabihin mo lang kung kailan ka free.");
    } else {
      await sendText(psid, "Medyo late na for same-day viewing. What day/time works for you tomorrow (or next available day)?");
    }
    return;
  }

  // If we already had a schedule, proceed to contact
  await contactStep(psid, session);
}

export async function cashHandle(psid, session, userText) {
  // Step 1: Scheduling
  if (needsSchedule(session)) {
    if (captureScheduleFromText(session, userText)) {
      await sendText(psid, summarizeProposed(session.schedule.when));
    } else {
      await sendText(psid, "Sige. Anong day at time ka pwede pumunta? (e.g., “Fri 2pm”, “Tomorrow morning”)");
      return;
    }
  }

  // Step 2: Contact info (mobile then fullname). Gatekeep address until provided.
  await contactStep(psid, session);
}

async function contactStep(psid, session) {
  if (needsContact(session)) {
    const missing = missingContactField(session);
    if (missing === 'mobile') {
      await sendText(psid, "Para ma-lock ko yung schedule, paki-send ng mobile number mo (PH format).");
      return;
    }
    if (missing === 'fullname') {
      await sendText(psid, "Noted. Paki-send ng full name mo rin (first & last).");
      return;
    }
  }

  // Step 3: Reveal address only after mobile+name provided
  const addr = await resolveAddressByChosen(session);
  if (addr) {
    await sendText(psid, `Complete address of the unit:\n${addr}\n\nSee you on your schedule! If may changes, message mo lang ako.`);
  } else {
    await sendText(psid, "Nakuha ko na details mo. Iche-check ko ang exact address and i-text ka namin for confirmation.");
  }

  // Phase wrap (ready for sheet logging in your next phase)
  session.phase = 'done_cash';
}

// Guard if user asks address too early
export async function cashAddressGate(psid) {
  await sendText(psid, "Ibibigay ko ang full address once ma-lock natin ang viewing schedule + contact details mo. Para ma-prepare yung unit at ma-assist ka ng team.");
}

// Capture contact from free text
export function cashTryCaptureContact(session, userText) {
  // Try mobile first, then name
  if (!session?.contact?.mobile && tryCaptureMobile(session, userText)) return 'mobile';
  if (session?.contact?.mobile && !session?.contact?.fullname && tryCaptureName(session, userText)) return 'fullname';
  return null;
}
