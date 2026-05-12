// server.js — VidScan Backend v2
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'VidScan API', version: '2.0' }));

// ── fetch URL (best effort) ───────────────────────────────────
function fetchUrl(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: 'GET', timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8,zh-CN;q=0.7',
        'Connection': 'close',
      }
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume();
        return fetchUrl(next, hops + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let html = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => { size += chunk.length; if (size < 300000) html += chunk; else res.destroy(); });
      res.on('end', () => resolve(html));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function parseMeta(html, url) {
  const g = (patterns) => {
    for (const p of patterns) { const m = html.match(p); if (m) return m[1]; }
    return '';
  };
  const decode = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\\n/g,' ').replace(/\\u[\dA-F]{4}/gi, m => String.fromCharCode(parseInt(m.slice(2),16))).trim();

  return {
    title: decode(g([
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{2,200})["']/i,
      /<meta[^>]+content=["']([^"']{2,200})["'][^>]+property=["']og:title["']/i,
      /"title":"([^"]{2,200})"/,
      /<title[^>]*>([^<]{2,200})<\/title>/i,
    ])),
    description: decode(g([
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{5,500})["']/i,
      /<meta[^>]+content=["']([^"']{5,500})["'][^>]+property=["']og:description["']/i,
      /"desc":"([^"]{5,500})"/,
      /"content":"([^"]{5,500})"/,
    ])),
    image: g([
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    ]),
    url,
  };
}

// POST /fetch-url
app.post('/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const html = await fetchUrl(url);
    const meta = parseMeta(html, url);
    res.json({ success: true, meta });
  } catch (err) {
    res.json({ success: false, error: err.message, meta: { title:'', description:'', image:'', url } });
  }
});

// ── Claude API ────────────────────────────────────────────────
function callClaude(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:2000, system, messages:[{role:'user',content:user}] });
    const req = https.request({
      hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{ 'Content-Type':'application/json','x-api-key':KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message));
          const text = p.content?.find(b => b.type==='text')?.text || '';
          let s = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
          const start = s.indexOf('{');
          if (start===-1) return reject(new Error('No JSON'));
          let depth=0,end=-1,inStr=false,esc=false;
          for (let i=start;i<s.length;i++) {
            const c=s[i];
            if(esc){esc=false;continue} if(c==='\\'){esc=true;continue}
            if(c==='"'){inStr=!inStr;continue} if(inStr)continue;
            if(c==='{')depth++; else if(c==='}'){depth--;if(depth===0){end=i;break;}}
          }
          if(end===-1) return reject(new Error('Malformed JSON'));
          resolve(JSON.parse(s.slice(start,end+1)));
        } catch(e){ reject(e); }
      });
    });
    req.on('error',reject);
    req.write(body);
    req.end();
  });
}

// POST /analyze
app.post('/analyze', async (req, res) => {
  if (!KEY) return res.status(500).json({ error:'ANTHROPIC_API_KEY not set' });
  const { title, description, url, fetchedMeta } = req.body;
  const T = fetchedMeta?.title || title || '';
  const D = fetchedMeta?.description || description || '';
  const U = url || '';
  if (!T && !D) return res.status(400).json({ error:'กรุณาใส่ชื่อวิดีโอหรือ caption' });

  try {
    const result = await callClaude(
      `คุณคือผู้เชี่ยวชาญการตลาดออนไลน์และ Content Strategy สำหรับทีม Reels ขายสินค้าในไทย ตอบ JSON เท่านั้น ห้ามมีข้อความอื่น`,
      `วิดีโอจาก Xiaohongshu:
URL: ${U||'(ไม่มี)'}
Title: ${T||'(ไม่มี)'}
Caption/Description: ${D||'(ไม่มี)'}

ตอบ JSON นี้เท่านั้น:
{"mainProduct":"ชื่อสินค้าหลัก","topic":"สรุป 1-2 ประโยค","sellingPoints":["จุดขาย1","จุดขาย2","จุดขาย3"],"problemSolved":"ปัญหาที่แก้ได้","targetAudience":"กลุ่มเป้าหมาย","viralScore":8.5,"viralReasons":["เหตุผล1","เหตุผล2"],"clipHook":"วิธีเปิดคลิป","clipMiddle":"กลางคลิป","clipCTA":"ปิดคลิป/CTA","searchKeywords":["kw1","kw2","kw3"],"shopeeKeyword":"keyword ภาษาไทย Shopee","lazadaKeyword":"keyword ภาษาไทย Lazada","covers":{"attractive":["ข้อ1","ข้อ2","ข้อ3"],"selling":["ข้อ1","ข้อ2","ข้อ3"],"problem":["ข้อ1","ข้อ2","ข้อ3"],"viral":["ข้อ1","ข้อ2","ข้อ3"]},"captions":[{"id":1,"style":"ดราม่า","text":"แคปชั่น\\nหลายบรรทัด\\nมี emoji และ CTA","cta":"comment"},{"id":2,"style":"น่ารัก","text":"...","cta":"share"},{"id":3,"style":"serious","text":"...","cta":"shop"},{"id":4,"style":"ตลก","text":"...","cta":"follow"},{"id":5,"style":"กระตุ้น","text":"...","cta":"comment"}]}

กฎ: ภาษาไทย, ข้อความปกไม่เกิน 12 คำ, แคปชั่น 4-5 บรรทัด มี emoji 3-5 ตัว มี CTA`
    );
    res.json({ success:true, data:result });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error:err.message });
  }
});

app.listen(PORT, () => console.log(`VidScan v2 on port ${PORT} | KEY:${KEY?'SET':'NOT SET'}`));
