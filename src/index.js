import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { prisma } from './lib/prisma.js';
import { generateRequestNo } from './lib/requestNo.js';
import { verifyLiffToken } from './lib/lineAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// โฟลเดอร์เก็บไฟล์แนบ (สลิป/ใบเสนอราคา)
// หมายเหตุสำคัญ: บน Render free/standard instance โฟลเดอร์นี้ "ไม่ถาวร" — ไฟล์จะหายเมื่อ redeploy หรือ restart
// เหมาะสำหรับทดสอบ/MVP เท่านั้น ก่อนขึ้นใช้งานจริงควรย้ายไปเก็บที่ Cloudflare R2 หรือ Render Persistent Disk
const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();

const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'liff-request-backend' });
});

// ขั้นตอน ① — ผู้ขอเบิกส่งคำขอเข้ามาจากฟอร์ม LIFF
app.post('/requests', upload.single('attachment'), async (req, res) => {
  try {
    const { requesterName, unit, purpose, category, amount, neededDate, note, lineUserId } = req.body;

    if (!requesterName || !unit || !purpose || !category || !amount || !neededDate) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ กรุณากรอกให้ครบทุกช่องที่จำเป็น' });
    }

    // ตรวจสอบตัวตนผ่าน LINE (เปิด/ปิดได้ด้วย env REQUIRE_LIFF_AUTH — ปิดไว้เป็นค่าเริ่มต้นระหว่างพัฒนา)
    if (process.env.REQUIRE_LIFF_AUTH === 'true') {
      const authHeader = req.headers.authorization || '';
      const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const verified = await verifyLiffToken(accessToken);
      if (!verified) {
        return res.status(401).json({ error: 'ยืนยันตัวตนผ่าน LINE ไม่สำเร็จ' });
      }
    }

    const requestNo = await generateRequestNo(prisma);

    const created = await prisma.request.create({
      data: {
        requestNo,
        requesterName,
        unit,
        purpose,
        category,
        amount: parseFloat(amount),
        neededDate: new Date(neededDate),
        note: note || null,
        attachmentName: req.file ? req.file.originalname : null,
        attachmentUrl: req.file ? `/uploads/${req.file.filename}` : null,
        lineUserId: lineUserId || null,
        status: 'pending_approval',
      },
    });

    // TODO (ขั้นตอน ②): ส่ง Flex Message แจ้ง ผบ.หน่วย ผ่าน LINE Messaging API ตรงนี้
    // ต้องใช้ LINE_CHANNEL_ACCESS_TOKEN ของ channel "ขอเบิกเงิน (ธุรการ)"

    res.status(201).json({ requestNo: created.requestNo });
  } catch (err) {
    console.error('POST /requests failed:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
  }
});

// รายการคำขอทั้งหมด — ไว้ใช้ตอนสร้างหน้าอนุมัติ (ขั้นตอน ②) ในอนาคต
app.get('/requests', async (req, res) => {
  try {
    const requests = await prisma.request.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(requests);
  } catch (err) {
    console.error('GET /requests failed:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`liff-request-backend listening on port ${port}`);
});
