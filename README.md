# liff-request-backend

Backend API รับคำขอเบิกเงินจากฟอร์ม LIFF (ขั้นตอนที่ ①) เก็บลงฐานข้อมูล PostgreSQL
เขียนด้วย Node.js + Express + Prisma

## สิ่งที่ทำได้ตอนนี้

- `POST /requests` — รับข้อมูลจากฟอร์ม LIFF, ออกเลขที่คำขอ, บันทึกลงฐานข้อมูล
- `GET /requests` — ดึงรายการคำขอทั้งหมด (เตรียมไว้ใช้ตอนสร้างหน้าอนุมัติ ขั้นตอน ②)

**ยังไม่ทำ** (จะสร้างต่อในขั้นตอน ②③④): ส่ง Flex Message แจ้ง ผบ.หน่วย, หน้าอนุมัติ, หน้าจ่ายเงิน, หน้าส่งหลักฐาน

**ข้อจำกัดที่ควรรู้**: ไฟล์แนบ (สลิป/ใบเสนอราคา) เก็บไว้ในโฟลเดอร์ `uploads/` บนเครื่อง server ซึ่ง **ไม่ถาวร** — ถ้า Render redeploy หรือ restart เครื่อง ไฟล์จะหายหมด เหมาะสำหรับทดสอบเท่านั้น ก่อนใช้งานจริงควรย้ายไปเก็บที่ Cloudflare R2 (แจ้งได้เมื่อพร้อมทำ)

## 1. รันบนเครื่องก่อน (ทดสอบ)

ต้องมี PostgreSQL สักตัวให้ต่อ — ถ้ายังไม่มีบนเครื่อง ข้ามขั้นนี้ไปสร้างบน Render เลยก็ได้ (ข้อ 3-4) แล้วเอา connection string มาใส่ `.env` เพื่อรันทดสอบบนเครื่องได้เหมือนกัน

```bash
npm install
cp .env.example .env
# แก้ .env ใส่ DATABASE_URL
npx prisma db push
npm run dev
```

เซิร์ฟเวอร์จะรันที่ `http://localhost:3000` — ทดสอบว่าทำงานไหมด้วยการเปิด URL นั้นในเบราว์เซอร์ ควรเห็น `{"ok":true,...}`

## 2. เก็บโค้ดขึ้น GitHub (repo ใหม่แยกจาก frontend)

```bash
git init
git add .
git commit -m "initial backend"
```
สร้าง repo ใหม่บน GitHub (เช่น `liff-request-backend`) แล้ว push ตามที่ GitHub บอก

## 3. สร้างฐานข้อมูลบน Render

1. เข้า [render.com](https://render.com) สมัคร/login (เชื่อมกับ GitHub ได้เลย)
2. Dashboard → **New +** → **PostgreSQL**
3. ตั้งชื่อ เช่น `liff-request-db` → เลือก region ใกล้ๆ (Singapore ถ้ามี) → **Create Database**
4. รอสักครู่ database จะพร้อมใช้งาน → เข้าไปหน้า database นั้น หา **"Internal Database URL"** หรือ **"External Database URL"** — copy เก็บไว้ (จะใช้ External URL ถ้าต่อจากเครื่องเรา หรือ Internal URL ถ้า backend อยู่บน Render เหมือนกัน แนะนำใช้ Internal เพราะเร็วกว่าและฟรีไม่เสียค่า bandwidth)

## 4. สร้าง Web Service บน Render

1. Dashboard → **New +** → **Web Service**
2. เชื่อม GitHub repo `liff-request-backend` ที่เพิ่ง push ไป
3. ตั้งค่า:
   - **Name**: `liff-request-backend`
   - **Region**: เดียวกับ database
   - **Build Command**: `npm install && npx prisma generate`
   - **Start Command**: `npx prisma db push --accept-data-loss --skip-generate && node src/index.js`
   - **Instance Type**: Free ก็ได้สำหรับทดสอบ
4. เลื่อนลงไปที่ **Environment Variables** เพิ่ม:
   - `DATABASE_URL` = Internal Database URL จากข้อ 3
   - `FRONTEND_ORIGIN` = `https://liff-request-form-financial.chateau-huahin.workers.dev`
   - `REQUIRE_LIFF_AUTH` = `false`
5. กด **Create Web Service** รอ build (2-5 นาที)

พอ deploy เสร็จจะได้ URL แบบ:
```
https://liff-request-backend.onrender.com
```
เปิดดูควรเห็น `{"ok":true,...}` เหมือนตอนรันบนเครื่อง

**หมายเหตุ Free tier**: เครื่องจะ sleep เมื่อไม่มีคนเรียกนานเกิน 15 นาที พอมีคนเรียกครั้งแรกจะใช้เวลาปลุกเครื่อง ~30-60 วินาที (ปกติสำหรับ free tier ไม่ใช่ error)

## 5. เชื่อมกลับไปที่ฟอร์ม (Cloudflare)

กลับไปที่ Cloudflare Dashboard → โปรเจกต์ `liff-request-form-financial` → **Settings** → **Build** → **Variables and secrets** → เพิ่ม:
- **Variable name**: `VITE_API_BASE_URL`
- **Value**: `https://liff-request-backend.onrender.com` (URL จากข้อ 4 — **ห้ามมี `/` ปิดท้าย**)

จากนั้น trigger redeploy ฝั่ง frontend (จากเครื่อง ในโฟลเดอร์ `liff-request-form`):
```
git commit --allow-empty -m "connect backend api"
git push
```

## 6. ทดสอบยิงจริง

เปิดฟอร์มผ่าน LINE (หรือเว็บก็ได้) กรอกข้อมูล กด "ส่งคำขอเบิกเงิน" — ถ้าขึ้นหน้ายืนยันพร้อมเลขที่คำขอ (เช่น `REQ-2569-0001`) แปลว่าระบบทำงานครบวงจรตั้งแต่ฟอร์มถึงฐานข้อมูลแล้ว 🎉

ตรวจสอบข้อมูลที่บันทึกได้ด้วยการเปิด:
```
https://liff-request-backend.onrender.com/requests
```
จะเห็น JSON รายการคำขอทั้งหมดที่เคยส่งเข้ามา
