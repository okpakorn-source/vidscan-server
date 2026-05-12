// server.js v3 — แก้ Malformed JSON + เพิ่ม debug
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.json({ status:'ok', service:'VidScan API', version:'3.0', hasKey: !!KEY }));

// ── robust JSON extractor ─────────────────────────────────────
function extractJSON(text) {
  // strip markdown fences
  let s = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in Claude response');
  
  // find matching closing brace
  let depth=0, end=-1, inStr=false, esc=false;
  for (let i=start; i<s.length; i++) {
    const c = s[i];
    if (esc) { esc=false; continue; }
    if (c==='\\') { esc=true; continue; }
    if (c==='"') { inStr=!inStr; continue; }
    if (inStr) continue;
    if (c==='{') depth++;
    else if (c==='}') { depth--; if (depth===0) { end=i; break; } }
  }
  
  if (end === -1) throw new Error('JSON object not closed properly');
  
  let chunk = s.slice(start, end+1);
  
  // attempt 1: direct parse
  try { return JSON.parse(chunk); } catch(e1) {}
  
  // attempt 2: fix literal newlines inside string values
  try {
    const fixed = chunk.replace(/("(?:[^"\\]|\\.)*")|(\n)/g, (match, str, nl) => {
      if (nl) return '\\n';  // literal newline outside strings → escape
      return match;           // keep strings as-is
    });
    return JSON.parse(fixed);
  } catch(e2) {}
  
  // attempt 3: aggressive fix - remove control chars, fix trailing commas
  try {
    let aggressive = chunk
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // control chars
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/,(\s*[}\]])/g, '$1'); // trailing commas
    return JSON.parse(aggressive);
  } catch(e3) {
    throw new Error(`Cannot parse JSON after 3 attempts. Last error: ${e3.message}. First 200 chars: ${chunk.slice(0,200)}`);
  }
}

// ── fetch URL ─────────────────────────────────────────────────
function fetchUrl(url, hops=0) {
  return new Promise((resolve, reject) => {
    if (hops>6) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method:'GET', timeout:10000,
      headers:{
        'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept':'text/html,*/*;q=0.8',
        'Accept-Language':'th-TH,th;q=0.9,en;q=0.8',
        'Connection':'close',
      }
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume();
        return fetchUrl(next, hops+1).then(resolve).catch(reject);
      }
      if (res.statusCode!==200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let html='', size=0;
      res.setEncoding('utf8');
      res.on('data', c => { size+=c.length; if(size<300000) html+=c; else res.destroy(); });
      res.on('end', () => resolve(html));
      res.on('error', reject);
    });
    req.on('timeout', ()=>{ req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function parseMeta(html, url) {
  const g = (...patterns) => { for(const p of patterns){const m=html.match(p);if(m)return m[1]||'';} return ''; };
  const dec = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\\n/g,' ').trim();
  return {
    title: dec(g(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{2,200})["']/i, /<meta[^>]+content=["']([^"']{2,200})["'][^>]+property=["']og:title["']/i, /"title":"([^"]{2,200})"/, /<title[^>]*>([^<]{2,200})<\/title>/i)),
    description: dec(g(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{5,500})["']/i, /<meta[^>]+content=["']([^"']{5,500})["'][^>]+property=["']og:description["']/i, /"desc":"([^"]{5,500})"/, /"content":"([^"]{5,500})"/)),
    image: g(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i),
    url,
  };
}

app.post('/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:'url required' });
  try {
    const html = await fetchUrl(url);
    const meta = parseMeta(html, url);
    res.json({ success:true, meta });
  } catch(err) {
    res.json({ success:false, error:err.message, meta:{ title:'', description:'', image:'', url } });
  }
});

// ── Claude API ────────────────────────────────────────────────
function callClaude(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system,
      messages: [{ role:'user', content:user }]
    });

    const req = https.request({
      hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key': KEY,
        'anthropic-version':'2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data='';
      res.on('data', c => data+=c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Anthropic: ${parsed.error.message}`));
          const text = parsed.content?.find(b => b.type==='text')?.text || '';
          console.log('Claude raw response (first 500):', text.slice(0,500));
          const json = extractJSON(text);
          resolve(json);
        } catch(e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── POST /analyze ─────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  if (!KEY) return res.status(500).json({ error:'ANTHROPIC_API_KEY ยังไม่ได้ตั้งค่าใน Render Environment' });

  const { title, description, url, fetchedMeta } = req.body;
  const T = (fetchedMeta?.title || title || '').trim();
  const D = (fetchedMeta?.description || description || '').trim();
  const U = (url || '').trim();

  if (!T && !D) return res.status(400).json({ error:'กรุณาใส่ชื่อวิดีโอหรือ caption อย่างน้อยหนึ่งอย่าง' });

  const systemPrompt = `คุณคือผู้เชี่ยวชาญการตลาดออนไลน์และ Content Strategy สำหรับทีม Reels ขายสินค้าในไทย
คุณต้องตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่นก่อนหรือหลัง JSON เด็ดขาด
ห้ามใช้ markdown code blocks อย่างเด็ดขาด
ตอบด้วย raw JSON object เริ่มต้นด้วย { และจบด้วย } เท่านั้น`;

  const userPrompt = `วิดีโอจาก Xiaohongshu:
URL: ${U||'(ไม่มี)'}
Title: ${T||'(ไม่มี)'}
Description: ${D||'(ไม่มี)'}

ตอบด้วย JSON object นี้เท่านั้น (raw JSON ห้ามมี markdown):
{"mainProduct":"ชื่อสินค้าหลัก","topic":"สรุป 1-2 ประโยค","sellingPoints":["จุดขาย1","จุดขาย2","จุดขาย3"],"problemSolved":"ปัญหาที่แก้ได้","targetAudience":"กลุ่มเป้าหมาย","viralScore":8.5,"viralReasons":["เหตุผล1","เหตุผล2"],"clipHook":"วิธีเปิดคลิป","clipMiddle":"กลางคลิป","clipCTA":"ปิดคลิป","searchKeywords":["kw1","kw2","kw3"],"shopeeKeyword":"keyword Shopee ภาษาไทย","lazadaKeyword":"keyword Lazada ภาษาไทย","covers":{"attractive":["ข้อ1","ข้อ2","ข้อ3"],"selling":["ข้อ1","ข้อ2","ข้อ3"],"problem":["ข้อ1","ข้อ2","ข้อ3"],"viral":["ข้อ1","ข้อ2","ข้อ3"]},"captions":[{"id":1,"style":"ดราม่า","text":"บรรทัด1\\nบรรทัด2\\nบรรทัด3 emoji\\nCTA","cta":"comment"},{"id":2,"style":"น่ารัก","text":"บรรทัด1\\nบรรทัด2\\nบรรทัด3 emoji\\nCTA","cta":"share"},{"id":3,"style":"serious","text":"บรรทัด1\\nบรรทัด2\\nบรรทัด3 emoji\\nCTA","cta":"shop"},{"id":4,"style":"ตลก","text":"บรรทัด1\\nบรรทัด2\\nบรรทัด3 emoji\\nCTA","cta":"follow"},{"id":5,"style":"กระตุ้น","text":"บรรทัด1\\nบรรทัด2\\nบรรทัด3 emoji\\nCTA","cta":"comment"}]}

กฎ: ภาษาไทยทั้งหมด, ข้อความปกไม่เกิน 12 คำ, แคปชั่นใช้ \\n แทนการขึ้นบรรทัดใหม่`;

  try {
    const result = await callClaude(systemPrompt, userPrompt);
    res.json({ success:true, data:result });
  } catch(err) {
    console.error('analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`VidScan v3 | port:${PORT} | key:${KEY?'SET✓':'NOT SET✗'}`);
});
