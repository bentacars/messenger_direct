const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

function validatePsid(psid) {
  if (typeof psid !== 'string' || !/^\d{5,}$/.test(psid)) {
    throw new Error(`Invalid PSID: "${String(psid)}"`);
  }
}

async function callSendAPI(body) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`FB send error ${res.status} ${text}`);
  }
}

export async function sendTypingOn(psid) {
  validatePsid(psid);
  await callSendAPI({ recipient:{ id: psid }, sender_action:'typing_on' });
}
export async function sendTypingOff(psid) {
  validatePsid(psid);
  await callSendAPI({ recipient:{ id: psid }, sender_action:'typing_off' });
}
export async function sendText(psid, text) {
  validatePsid(psid);
  await callSendAPI({ recipient:{ id: psid }, message:{ text } });
}
export async function sendImage(psid, imageUrl) {
  validatePsid(psid);
  await callSendAPI({
    recipient:{ id: psid },
    message:{
      attachment:{
        type:'image',
        payload:{ url:imageUrl, is_reusable:false }
      }
    }
  });
}
/** Carousel if supported; gracefully skip if elements empty */
export async function sendGallery(psid, elements) {
  validatePsid(psid);
  if (!Array.isArray(elements) || !elements.length) return;
  await callSendAPI({
    recipient:{ id: psid },
    message:{
      attachment:{
        type:'template',
        payload:{ template_type:'generic', elements }
      }
    }
  });
}
