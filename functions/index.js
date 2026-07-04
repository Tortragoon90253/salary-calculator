/**
 * Gemini Proxy — ผู้ช่วยการเงิน AI (salary-calculator)
 * ─────────────────────────────────────────────────────────
 * หลักการ: เบราว์เซอร์ "ไม่ถือ" Gemini API key เลย
 *   เบราว์เซอร์ ──► ฟังก์ชันนี้ (ถือ key + ยาม) ──► Google Gemini
 *
 * ยามที่ใส่ไว้:
 *   1) Access Code   — ให้เฉพาะคนที่รู้รหัสเรียกได้
 *   2) Rate limit    — จำกัดจำนวนครั้งต่อรหัสต่อวัน (เก็บใน Firestore)
 *   3) Allowlist โมเดล + จำกัดขนาด body — กันคนยัด input ยักษ์
 *   4) CORS          — จำกัดโดเมนที่เรียกได้ (ตั้งค่าได้)
 *
 * Secrets ที่ต้องตั้งก่อน deploy (ดู README.md):
 *   GEMINI_KEY    = คีย์ Gemini จริง (ตัวเดียว เก็บฝั่งเซิร์ฟเวอร์)
 *   ACCESS_CODES  = รหัสเข้าใช้ คั่นด้วย comma เช่น "myhome,wife2024"
 *                   (ถ้าเว้นว่าง = ไม่ตรวจรหัส — ไม่แนะนำสำหรับ endpoint สาธารณะ)
 */
const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const GEMINI_KEY = defineSecret('GEMINI_KEY');
const ACCESS_CODES = defineSecret('ACCESS_CODES');

/* ── ปรับแต่งได้ ── */
const DAILY_LIMIT = 60;                         // จำนวนครั้งต่อ 1 รหัสต่อวัน
const MAX_BODY = 256 * 1024;                    // ~256KB (พอสำหรับรูปสลิปที่ย่อแล้ว)
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-1.5-flash',
]);
// โดเมนที่อนุญาตให้เรียก ('*' = ทุกที่). ใส่ origin ของเว็บคุณเพื่อความปลอดภัยขึ้น
// เช่น ['https://yourname.github.io', 'http://localhost:8080']
const ALLOWED_ORIGINS = ['*'];

function pickOrigin(reqOrigin) {
  if (ALLOWED_ORIGINS.includes('*')) return reqOrigin || '*';
  return ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
}
function setCors(res, reqOrigin) {
  res.set('Access-Control-Allow-Origin', pickOrigin(reqOrigin));
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
}

exports.askAI = onRequest(
  {
    secrets: [GEMINI_KEY, ACCESS_CODES],
    region: 'asia-southeast1',   // สิงคโปร์ — ใกล้ไทย latency ต่ำ
    cors: false,                 // จัดการ CORS เอง (ด้านล่าง)
    maxInstances: 5,             // กันบิลบานปลาย
    timeoutSeconds: 60,
  },
  async (req, res) => {
    setCors(res, req.headers.origin);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') {
      res.status(405).json({error: {message: 'ใช้ POST เท่านั้น'}}); return;
    }

    try {
      // 1) ตรวจ Access Code (จาก header "Authorization: Bearer <code>" หรือ body.code)
      const codes = (ACCESS_CODES.value() || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const authHdr = req.headers.authorization || '';
      const code = authHdr.startsWith('Bearer ')
        ? authHdr.slice(7).trim()
        : ((req.body && req.body.code) || '').trim();
      if (codes.length && !codes.includes(code)) {
        res.status(401).json({error: {message: 'รหัสเข้าใช้ไม่ถูกต้อง'}}); return;
      }

      // 2) ตรวจขนาด + รูปทรงของ body
      const rawLen = (req.rawBody && req.rawBody.length) ||
        JSON.stringify(req.body || {}).length;
      if (rawLen > MAX_BODY) {
        res.status(413).json({error: {message: 'คำขอใหญ่เกินไป (ลองย่อรูปสลิป)'}}); return;
      }
      const body = req.body || {};
      const contents = body.contents;
      if (!Array.isArray(contents) || !contents.length) {
        res.status(400).json({error: {message: 'ไม่มีเนื้อหา (contents)'}}); return;
      }
      const model = ALLOWED_MODELS.has(body.model) ? body.model : 'gemini-2.5-flash';

      // 3) Rate limit — นับต่อรหัสต่อวัน (atomic ด้วย transaction)
      const day = new Date().toISOString().slice(0, 10);      // YYYY-MM-DD (UTC)
      const usageRef = db.collection('ai_usage').doc(`${code || 'anon'}_${day}`);
      const used = await db.runTransaction(async (t) => {
        const snap = await t.get(usageRef);
        const n = (snap.exists ? (snap.data().count || 0) : 0) + 1;
        t.set(usageRef, {
          count: n, day, code: code || 'anon',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        return n;
      });
      if (used > DAILY_LIMIT) {
        res.status(429).json({error: {message:
          `ใช้ครบโควตาวันนี้แล้ว (${DAILY_LIMIT} ครั้ง) — ลองใหม่พรุ่งนี้`}});
        return;
      }

      // 4) เรียก Gemini ด้วย key ฝั่งเซิร์ฟเวอร์ แล้วส่งผลลัพธ์กลับตรงๆ
      const url = `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${model}:generateContent?key=${GEMINI_KEY.value()}`;
      const gres = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          contents,
          systemInstruction: body.systemInstruction,
          generationConfig: body.generationConfig,
        }),
      });
      const data = await gres.json();
      res.status(gres.status).json(data);
    } catch (e) {
      console.error('askAI error:', e);
      res.status(500).json({error: {message: e.message || 'proxy error'}});
    }
  },
);
