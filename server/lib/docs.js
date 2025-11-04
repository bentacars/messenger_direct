// Financing docs flow: detect first file/photo receipt -> mark received.

export function ensureDocsStore(session) {
  if (!session.docs) session.docs = { awaiting: true, receivedAt: null };
}

export function markDocsReceived(session) {
  ensureDocsStore(session);
  session.docs.awaiting = false;
  session.docs.receivedAt = Date.now();
}

export function detectDocsFromAttachments(attachments) {
  // Messenger attachment types we consider as "docs sent"
  // images / file / audio / video (we'll accept images and files mainly)
  if (!Array.isArray(attachments)) return false;
  return attachments.some(a => {
    const t = String(a?.type || '').toLowerCase();
    return t === 'image' || t === 'file';
  });
}
