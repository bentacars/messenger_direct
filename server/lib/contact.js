// Phone & name capture (PH-friendly but permissive)

const PH_MOBILE = /^(?:\+?63|0)9\d{9}$/; // ex: 09XXXXXXXXX or +639XXXXXXXXX

export function needsContact(session) {
  return !(session.contact && session.contact.mobile && session.contact.fullname);
}

export function ensureContactStore(session) {
  if (!session.contact) session.contact = { mobile: null, fullname: null };
}

export function tryCaptureMobile(session, text) {
  ensureContactStore(session);
  const t = (text || '').replace(/[^\d+]/g, '');
  if (PH_MOBILE.test(t)) {
    session.contact.mobile = t.startsWith('+') ? t : (t.startsWith('0') ? '+63' + t.slice(1) : '+63' + t);
    return true;
  }
  return false;
}

export function tryCaptureName(session, text) {
  ensureContactStore(session);
  const t = String(text || '').trim();
  if (t.split(' ').length >= 2 && t.length >= 5) {
    session.contact.fullname = t.replace(/\s+/g, ' ').trim();
    return true;
  }
  return false;
}

export function missingContactField(session) {
  ensureContactStore(session);
  if (!session.contact.mobile) return 'mobile';
  if (!session.contact.fullname) return 'fullname';
  return null;
}
