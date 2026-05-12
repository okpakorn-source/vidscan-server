// server.js v4 — VidScan with Gemini Video Analysis
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const GEMINI_KEY     = process.env.GEMINI_API_KEY     || '';
const RAILWAY_WORKER = (process.env.RAILWAY_WORKER_URL || '').replace(/\/$/, '');

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => res.json({
  status:'ok', service:'VidScan v4',
  config:{ anthropic:!!ANTHROPIC_KEY, gemini:!!GEMINI_KEY, railway:!!RAILWAY_WORKER }
}));

function httpPost(urlStr, body, extraHeaders={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol==='https:' ? https : http;
    const bs = JSON.stringify(body);
    const req = lib.request({
      hostname:u.hostname, port:u.port||(u.protocol==='https:'?443:80),
      path:u.pathname+u.search, method:'POST', timeout:120000,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bs),...extraHeaders}
    }, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{resolve({status:res.statusCode,body:JSON.parse(d)});}
        catch(e){resolve({status:res.statusCode,body:{raw:d.slice(0,500)}});}
      });
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject);
    req.write(bs); req.end();
  });
}

function extractJSON(text) {
  let s = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  const start = s.indexOf('{');
  if(start===-1) throw new Error('No JSON');
  let depth=0,end=-1,inStr=false,esc=false;
  for(let i=start;i<s.length;i++){
    const c=s[i];
    if(esc){esc=false;continue} if(c==='\\'){esc=true;continue}
    if(c==='"'){inStr=!inStr;continue} if(inStr)continue;
    if(c==='{')depth++; else if(c==='}'){depth--;if(depth===0){end=i;break;}}
  }
  if(end===-1) throw new Error('Unclosed JSON');
  const chunk=s.slice(start,end+1);
  try{return JSON.parse(chunk);}catch(e1){}
  try{return JSON.parse(chunk.replace(/\n/g,'\\n').replace(/\r/g,''));}catch(e2){}
  try{return JSON.parse(chunk.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/\n/g,'\\n').replace(/,(\s*[}\]])/g,'$1'));}
  catch(e3){throw new Error(`JSON parse failed: ${e3.message}`);}
}

async function extractFromRailway(url) {
  console.log('[Railway] extracting:', url);
  // try video first
  try {
    const r = await httpPost(`${RAILWAY_WORKER}/extract`, {url, mode:'video'});
    if(r.body.success && r.body.video_base64){
      console.log('[Railway] got video:', r.body.video_size_mb+'MB');
      return {type:'video', ...r.body};
    }
  } catch(e){ console.log('[Railway] video failed:', e.message); }
  // try thumbnail
  try {
    const r = await httpPost(`${RAILWAY_WORKER}/extract`, {url, mode:'thumbnail'});
    if(r.body.success && r.body.thumbnail_base64){
      console.log('[Railway] got thumbnail');
      return {type:'thumbnail', ...r.body};
    }
  } catch(e){ console.log('[Railway] thumbnail failed:', e.message); }
  // metadata only
  const r = await httpPost(`${RAILWAY_WORKER}/extract`, {url, mode:'metadata'});
  if(r.body.success) return {type:'metadata', ...r.body};
  throw new Error('Railway extraction failed: '+(r.body.error||'unknown'));
}

async function analyzeWithGemini(extracted) {
  const prompt = `วิเคราะห์สินค้าในวิดีโอ/รูปนี้จาก Xiaohongshu แล้วตอบ raw JSON เท่านั้น:
{"productName":"ชื่อสินค้าจริงที่เห็น","productCategory":"หมวดหมู่","productDescription":"รายละเอียดสินค้า","mainFeatures":["ฟีเจอร์1","ฟีเจอร์2","ฟีเจอร์3"],"targetUser":"กลุ่มเป้าหมาย","videoStyle":"สไตล์วิดีโอ","hookMoment":"จุดน่าสนใจ","estimatedPrice":"ราคาโดยประมาณ","productColors":["สี1"],"keyVisuals":"สิ่งที่เห็นชัด"}`;

  let parts=[], model='gemini-1.5-flash';
  if(extracted.type==='video' && extracted.video_base64){
    parts=[{inlineData:{mimeType:extracted.video_mime||'video/mp4',data:extracted.video_base64}},{text:prompt}];
    model='gemini-1.5-pro';
  } else if(extracted.type==='thumbnail' && extracted.thumbnail_base64){
    parts=[{inlineData:{mimeType:extracted.thumbnail_mime||'image/jpeg',data:extracted.thumbnail_base64}},{text:prompt}];
  } else {
    const m=extracted.data||{};
    parts=[{text:`${prompt}\n\nTitle: ${m.title||''}\nDescription: ${m.description||''}`}];
  }

  const r = await httpPost(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {contents:[{parts}], generationConfig:{temperature:0.1,maxOutputTokens:800}}
  );
  const text = r.body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if(!text) throw new Error('Gemini ไม่ตอบ: '+JSON.stringify(r.body).slice(0,200));
  console.log('[Gemini] response:', text.slice(0,200));
  return extractJSON(text);
}

async function claudeCopy(gemini, meta={}) {
  const bs = JSON.stringify({
    model:'claude-sonnet-4-20250514', max_tokens:2000,
    system:'คุณคือ Copywriter Reels ไทย ตอบ raw JSON เท่านั้น ห้ามมี markdown',
    messages:[{role:'user',content:`สินค้า: ${gemini.productName}
ประเภท: ${gemini.productCategory}
รายละเอียด: ${gemini.productDescription}
ฟีเจอร์: ${(gemini.mainFeatures||[]).join(', ')}
กลุ่มเป้าหมาย: ${gemini.targetUser}
Title จาก XHS: ${meta.title||''}
Description จาก XHS: ${meta.description||''}

ตอบ raw JSON:
{"topic":"สรุปคลิป 1-2 ประโยค","mainProduct":"${gemini.productName}","sellingPoints":["จุดขาย1","จุดขาย2","จุดขาย3"],"problemSolved":"ปัญหาที่แก้ได้","targetAudience":"${gemini.targetUser}","viralScore":8.5,"viralReasons":["เหตุผล1","เหตุผล2"],"clipHook":"วิธีเปิดคลิป","clipMiddle":"กลางคลิป","clipCTA":"ปิดคลิป","searchKeywords":["kw1","kw2","kw3"],"shopeeKeyword":"keyword Shopee","lazadaKeyword":"keyword Lazada","covers":{"attractive":["ข้อ1","ข้อ2","ข้อ3"],"selling":["ข้อ1","ข้อ2","ข้อ3"],"problem":["ข้อ1","ข้อ2","ข้อ3"],"viral":["ข้อ1","ข้อ2","ข้อ3"]},"captions":[{"id":1,"style":"ดราม่า","text":"แคปชั่น\\nบรรทัด2\\nemoji\\nCTA","cta":"comment"},{"id":2,"style":"น่ารัก","text":"...","cta":"share"},{"id":3,"style":"serious","text":"...","cta":"shop"},{"id":4,"style":"ตลก","text":"...","cta":"follow"},{"id":5,"style":"กระตุ้น","text":"...","cta":"comment"}]}`}]
  });
  return new Promise((resolve,reject)=>{
    const req=https.request({
      hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',timeout:60000,
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(bs)}
    },(res)=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{const p=JSON.parse(d);if(p.error)return reject(new Error(p.error.message));resolve(extractJSON(p.content?.find(b=>b.type==='text')?.text||''));}
        catch(e){reject(e);}
      });
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Claude timeout'));});
    req.on('error',reject); req.write(bs); req.end();
  });
}

// Main analyze endpoint
app.post('/analyze', async (req, res) => {
  const {url, title, description} = req.body;
  if(!ANTHROPIC_KEY) return res.status(500).json({error:'ANTHROPIC_API_KEY ยังไม่ได้ตั้งค่า'});
  if(!GEMINI_KEY)    return res.status(500).json({error:'GEMINI_API_KEY ยังไม่ได้ตั้งค่า'});

  try {
    let gemini, meta={};

    if(url && RAILWAY_WORKER){
      const extracted = await extractFromRailway(url);
      if(extracted.data)   meta=extracted.data;
      if(extracted.metadata) meta=extracted.metadata;
      gemini = await analyzeWithGemini(extracted);
    } else {
      if(!title && !description) return res.status(400).json({error:'กรุณาใส่ URL หรือ title+description'});
      meta = {title,description};
      gemini = await analyzeWithGemini({type:'metadata', data:{title,description}});
    }

    const copy = await claudeCopy(gemini, meta);
    res.json({success:true, data:{
      ...copy,
      mainProduct: gemini.productName || copy.mainProduct,
      productDetail:{
        name:gemini.productName, category:gemini.productCategory,
        description:gemini.productDescription, features:gemini.mainFeatures||[],
        colors:gemini.productColors||[], price:gemini.estimatedPrice||'',
        keyVisuals:gemini.keyVisuals||'',
      },
      analyzedBy:'gemini-vision'
    }});
  } catch(err){
    console.error('[analyze]', err.message);
    res.status(500).json({error:err.message});
  }
});

// Fallback: text-only analyze (no Gemini)
app.post('/analyze-text', async (req, res) => {
  if(!ANTHROPIC_KEY) return res.status(500).json({error:'ANTHROPIC_API_KEY ยังไม่ได้ตั้งค่า'});
  const {title,description} = req.body;
  if(!title&&!description) return res.status(400).json({error:'ต้องมี title หรือ description'});
  try {
    const gemini = await analyzeWithGemini({type:'metadata',data:{title,description}});
    const copy   = await claudeCopy(gemini, {title,description});
    res.json({success:true, data:{...copy, mainProduct:gemini.productName||copy.mainProduct, analyzedBy:'text-only'}});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.listen(PORT, ()=>{
  console.log(`VidScan v4 on :${PORT} | Anthropic:${!!ANTHROPIC_KEY} Gemini:${!!GEMINI_KEY} Railway:${!!RAILWAY_WORKER}`);
});
