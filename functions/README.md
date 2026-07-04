# 🛡️ Gemini Proxy — ตั้งค่าเซิร์ฟเวอร์ซ่อน API Key

โหมด "ผ่านเซิร์ฟเวอร์ (Proxy)" ของผู้ช่วย AI ทำให้ **เบราว์เซอร์ไม่ต้องถือ Gemini API key เลย**
key จริงเก็บไว้ฝั่ง Firebase Cloud Functions — client แค่เรียกผ่านด้วย "รหัสเข้าใช้" (Access Code)

```
เบราว์เซอร์ ──(รหัสเข้าใช้)──► Cloud Function (ถือ key + ยาม) ──► Google Gemini
```

ยามที่ติดตั้งให้แล้ว: ตรวจรหัสเข้าใช้ · จำกัดโควตาต่อวัน · จำกัดโมเดล/ขนาดคำขอ · CORS

---

## สิ่งที่ต้องมี (ทำครั้งเดียว)

1. โปรเจกต์ Firebase (โปรเจกต์เดียวกับที่ใช้ sync ข้อมูลก็ได้) — ต้องอยู่แผน **Blaze** (จ่ายตามใช้จริง; มีโควตาฟรีก้อนใหญ่ ใช้ส่วนตัวแทบไม่เสียเงิน)
2. ติดตั้ง Firebase CLI: `npm install -g firebase-tools`
3. Gemini API key จาก https://aistudio.google.com/app/apikey

---

## ขั้นตอน Deploy

```bash
# 1) เข้าโฟลเดอร์โปรเจกต์ (ที่มี firebase.json) แล้ว login
firebase login

# 2) ผูกกับโปรเจกต์ Firebase ของคุณ
firebase use --add            # เลือกโปรเจกต์ แล้วตั้ง alias เช่น "default"

# 3) ติดตั้ง dependencies ของฟังก์ชัน
cd functions && npm install && cd ..

# 4) ตั้ง "ความลับ" ฝั่งเซิร์ฟเวอร์ (จะถูกถามให้พิมพ์ค่า)
firebase functions:secrets:set GEMINI_KEY
#   → วาง Gemini API key จริง

firebase functions:secrets:set ACCESS_CODES
#   → พิมพ์รหัสเข้าใช้ คั่นด้วย comma ได้หลายรหัส เช่น:  home2024,wife
#     (รหัสนี้คือสิ่งที่คุณแจกให้คนที่ไว้ใจ — ไม่ใช่ Gemini key)

# 5) Deploy
firebase deploy --only functions
```

Deploy เสร็จ CLI จะพิมพ์ **Function URL** ออกมา หน้าตาประมาณ:

```
https://asia-southeast1-<project-id>.cloudfunctions.net/askAI
```

---

## เปิดใช้ในเว็บ

1. เปิดเว็บ → กด ✨ → ⚙️ → เลือกโหมด **🛡️ ผ่านเซิร์ฟเวอร์ (Proxy)**
2. วาง **Function URL** และ **รหัสเข้าใช้** (ตัวที่ตั้งใน `ACCESS_CODES`)
3. บันทึก — จากนี้เบราว์เซอร์จะไม่มี Gemini key อยู่เลย

> แต่ละอุปกรณ์ใส่ URL + รหัสครั้งเดียว (โดยเจตนา ไม่ฝังลงลิงก์แชร์ เพื่อไม่ให้รหัสหลุด)

---

## ปรับแต่งเพิ่ม (ในไฟล์ `functions/index.js`)

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `DAILY_LIMIT` | `60` | จำนวนครั้งต่อ 1 รหัสต่อวัน |
| `MAX_BODY` | `256KB` | ขนาดคำขอสูงสุด (กันรูปยักษ์) |
| `ALLOWED_MODELS` | 4 โมเดล | โมเดลที่อนุญาต |
| `ALLOWED_ORIGINS` | `['*']` | ใส่โดเมนเว็บคุณเพื่อล็อกให้เรียกได้เฉพาะที่นั่น |

แก้แล้ว deploy ใหม่ด้วย `firebase deploy --only functions`

---

## 🔒 หมายเหตุความปลอดภัย

- ตัวนับโควตาเก็บใน Firestore คอลเลกชัน `ai_usage` — ถ้า Firestore Rules ของคุณยังเป็น **Test mode (เปิดหมด)** client ที่มี config Firebase อาจแก้ตัวนับได้ แนะนำให้ล็อก Rules ให้เขียน `ai_usage` ได้เฉพาะฝั่งเซิร์ฟเวอร์ (admin SDK ข้าม Rules อยู่แล้ว) เช่น:
  ```
  match /ai_usage/{doc} { allow read, write: if false; }
  ```
- อยากปิดใช้ชั่วคราว: ลบ/แก้ค่า `ACCESS_CODES` แล้ว deploy ใหม่ หรือ `firebase functions:delete askAI`
- ดู log: `firebase functions:log`
