const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'VidScan API' });
});

function callClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = parsed.content?.find(b => b.type === 'text')?.text || '';
          const match = text.match(/\{[\s\S]*\}/);
          if (!match) return reject(new Error('No JSON in response'));
          resolve(JSON.parse(match[0]));
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/analyze', async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const result = await callClaude(
      `คุณคือผู้เชี่ยวชาญการตลาดออนไลน์สำหรับทีม Reels ขายสินค้าไทย ตอบ JSON เท่านั้น ห้ามมีข้อความอื่น`,
      `วิดีโอจาก Xiaohongshu:
ชื่อ: ${title}
Caption: ${description || '(ไม่มี)'}

ตอบ JSON รูปแบบนี้เท่านั้น:
{"mainProduct":"ชื่อสินค้า","topic":"สรุป 1-2 ประโยค","sellingPoints":["จุดขาย1","จุดขาย2","จุดขาย3"],"problemSolved":"ปัญหาที่แก้ได้","targetAudience":"กลุ่มเป้าหมาย","viralScore":8.5,"viralReasons":["เหตุผล1","เหตุผล2"],"clipHook":"วิธีเปิดคลิป","clipMiddle":"กลางคลิป","clipCTA":"ปิดคลิป","searchKeywords":["kw1","kw2","kw3"],"shopeeKeyword":"keyword ภาษาไทย","lazadaKeyword":"keyword ภาษาไทย","covers":{"attractive":["ข้อ1","ข้อ2","ข้อ3"],"selling":["ข้อ1","ข้อ2","ข้อ3"],"problem":["ข้อ1","ข้อ2","ข้อ3"],"viral":["ข้อ1","ข้อ2","ข้อ3"]},"captions":[{"id":1,"style":"ดราม่า","text":"แคปชั่น\\nหลายบรรทัด\\nพร้อม emoji","cta":"comment"},{"id":2,"style":"น่ารัก","text":"...","cta":"share"},{"id":3,"style":"serious","text":"...","cta":"shop"},{"id":4,"style":"ตลก","text":"...","cta":"follow"},{"id":5,"style":"กระตุ้น","text":"...","cta":"comment"}]}`
    );
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`VidScan server running on port ${PORT}`));
