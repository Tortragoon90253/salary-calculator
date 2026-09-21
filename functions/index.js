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
 *                   ★ ถ้าเว้นว่าง = ปฏิเสธทุกคำขอ (fail-closed) — endpoint นี้เปิดสาธารณะ
 *                     และหลังยามอยู่ Gemini key จริงที่คิดเงินตามใช้ ห้ามเปิดทิ้งไว้โดยไม่มีรหัส
 *                     (ตรงกับที่ README เขียนว่า "อยากปิดใช้ชั่วคราว: ลบค่า ACCESS_CODES")
 */
const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

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

/* เพดานฝั่งเซิร์ฟเวอร์ของ generationConfig — เดิมส่งต่อของจาก client ดิบๆ
   ใครมีรหัสจึงตั้ง maxOutputTokens/thinkingBudget เท่าไหร่ก็ได้ = บิลบานได้แม้ DAILY_LIMIT ยังไม่หมด
   (ค่าที่หน้าเว็บใช้จริงคือ 16384 / thinkingBudget 2048 จึงไม่กระทบการใช้งานปกติ) */
const MAX_OUTPUT_TOKENS = 16384;
const MAX_THINKING_BUDGET = 8192;
// null / undefined / '' = "ไม่ได้ส่งมา" → ใช้ค่าเริ่มต้น (Number(null) เป็น 0 จึงต้องกันเอง)
const numOr = (v, dflt) => (v === null || v === undefined || v === '' ||
  !Number.isFinite(Number(v)) ? dflt : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function safeGenConfig(g) {
  const src = (g && typeof g === 'object') ? g : {};
  const out = {
    temperature: clamp(numOr(src.temperature, 0.15), 0, 2),
    topP: clamp(numOr(src.topP, 0.9), 0, 1),
    maxOutputTokens: clamp(
      Math.round(numOr(src.maxOutputTokens, MAX_OUTPUT_TOKENS)), 1, MAX_OUTPUT_TOKENS),
  };
  const tb = src.thinkingConfig && src.thinkingConfig.thinkingBudget;
  if (tb != null) {
    out.thinkingConfig = {
      thinkingBudget: clamp(Math.round(numOr(tb, 0)), 0, MAX_THINKING_BUDGET),
    };
  }
  return out;
}

/* เทียบรหัสแบบไม่รั่วเวลา — ความเสี่ยงต่ำผ่าน HTTP แต่ราคาแก้แทบเป็นศูนย์ */
function codeMatches(codes, given) {
  const a = Buffer.from(String(given || ''));
  let hit = false;
  for (const c of codes) {
    const b = Buffer.from(c);
    // ความยาวต่างกันต้องเทียบกับตัวเองเพื่อคงเวลาให้ใกล้เคียง แล้วนับเป็นไม่ตรง
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) hit = true;
    else crypto.timingSafeEqual(a, a);
  }
  return hit;
}

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
      // fail-closed: ไม่ได้ตั้งรหัสไว้ = ปิดบริการ ไม่ใช่เปิดให้ทุกคนใช้ Gemini key ของเจ้าของฟรี
      if (!codes.length) {
        res.status(503).json({error: {message:
          'เซิร์ฟเวอร์ยังไม่ได้ตั้ง ACCESS_CODES — ปฏิเสธคำขอเพื่อความปลอดภัย ' +
          '(ตั้งด้วย: firebase functions:secrets:set ACCESS_CODES)'}});
        return;
      }
      if (!codeMatches(codes, code)) {
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

      // 3) Rate limit — จองโควตาก่อน (atomic ด้วย transaction) แล้วคืนถ้าเรียกไม่สำเร็จ
      const day = new Date().toISOString().slice(0, 10);      // YYYY-MM-DD (UTC)
      /* ใช้ hash ของรหัสเป็น doc id ไม่ใช่ตัวรหัสเอง — รหัสที่มี '/' จะกลายเป็น path ของ Firestore
         แล้วทั้งคำขอพังด้วย 500 · และไม่ต้องเก็บรหัสเป็น plaintext ไว้ในคอลเลกชัน
         (README เตือนว่า Rules แบบ test mode อาจให้ client อ่าน ai_usage ได้) */
      const codeKey = crypto.createHash('sha256').update(code).digest('hex').slice(0, 32);
      const usageRef = db.collection('ai_usage').doc(`${codeKey}_${day}`);
      const bump = (by) => db.runTransaction(async (t) => {
        const snap = await t.get(usageRef);
        const n = Math.max(0, (snap.exists ? (snap.data().count || 0) : 0) + by);
        t.set(usageRef, {
          count: n, day, codeHash: codeKey,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        return n;
      });
      /* คืนโควตาเมื่อคำขอไม่ได้คำตอบจริง — เดิมนับทุกครั้งที่ "ยิง" แม้ Gemini จะล่ม/หมดเวลา
         ฝั่ง client มี retry อัตโนมัติ 3 ครั้งตอนเจอ 429/5xx ด้วย คำถามเดียวจึงกินโควตาได้ถึง 3
         ทั้งที่ผู้ใช้ไม่เคยได้คำตอบสักครั้ง */
      let spent = false;
      const refund = async () => {
        if (!spent) return;
        spent = false;
        try {
          await bump(-1);
        } catch (err) {
          console.warn('quota refund failed:', err);
        }
      };

      const used = await bump(1);
      spent = true;
      if (used > DAILY_LIMIT) {
        await refund();   // คำขอที่ถูกปฏิเสธไม่ควรดันตัวนับให้สูงขึ้นเรื่อยๆ
        res.status(429).json({error: {message:
          `ใช้ครบโควตาวันนี้แล้ว (${DAILY_LIMIT} ครั้ง) — ลองใหม่พรุ่งนี้`}});
        return;
      }

      // 4) เรียก Gemini ด้วย key ฝั่งเซิร์ฟเวอร์ แล้วส่งผลลัพธ์กลับตรงๆ
      const url = `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${model}:generateContent?key=${GEMINI_KEY.value()}`;
      let gres;
      try {
        gres = await fetch(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            contents,
            systemInstruction: body.systemInstruction,
            generationConfig: safeGenConfig(body.generationConfig),
          }),
        });
      } catch (err) {
        await refund();
        throw err;
      }
      if (!gres.ok) await refund();   // 429/5xx ฝั่ง Google = ผู้ใช้ไม่ได้คำตอบ
      let data;
      try {
        data = await gres.json();
      } catch (err) {
        await refund();               // ตอบ 200 มาแต่ไม่ใช่ JSON = ผู้ใช้ก็ยังไม่ได้คำตอบอยู่ดี
        throw err;
      }
      res.status(gres.status).json(data);
    } catch (e) {
      console.error('askAI error:', e);
      res.status(500).json({error: {message: e.message || 'proxy error'}});
    }
  },
);
