const GRAPH = 'https://graph.facebook.com/v17.0/me/messages';

function mustToken(){ const t = process.env.FB_PAGE_TOKEN; if(!t) throw new Error('FB_PAGE_TOKEN missing'); return t; }
function validatePsid(psid){ if(!psid || typeof psid!=='string' || !/^\d{5,}$/.test(psid)) throw new Error(`Invalid PSID: "${psid}"`); }

async function fbSend(payload){
  const token = mustToken();
  const r = await fetch(`${GRAPH}?access_token=${encodeURIComponent(token)}`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok){ console.error('FB send error', r.status, j); throw new Error(JSON.stringify(j)); }
  return j;
}

export async function sendTypingOn(psid){ validatePsid(psid); return fbSend({ recipient:{id:psid}, sender_action:'typing_on' }); }
export async function sendTypingOff(psid){ validatePsid(psid); return fbSend({ recipient:{id:psid}, sender_action:'typing_off' }); }

export async function sendText(psid, text){
  validatePsid(psid);
  return fbSend({ recipient:{id:psid}, message:{ text } });
}

export async function sendImage(psid, url){
  validatePsid(psid);
  return fbSend({
    recipient:{id:psid},
    message:{ attachment:{ type:'image', payload:{ url, is_reusable:false } } }
  });
}

export async function sendQuickReplies(psid, text, replies){
  validatePsid(psid);
  return fbSend({
    recipient:{id:psid},
    message:{
      text,
      quick_replies: replies.map(r => ({ content_type:'text', title:r.title, payload:r.payload }))
    }
  });
}

// Optional: carousel
export async function sendGenericTemplate(psid, elements){
  validatePsid(psid);
  return fbSend({
    recipient:{id:psid},
    message:{
      attachment:{
        type:'template',
        payload:{ template_type:'generic', elements }
      }
    }
  });
}
