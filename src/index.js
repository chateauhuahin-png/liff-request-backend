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
import { verifySignature, pushMessage, replyMessage, buildApprovalFlex } from './lib/line.js';

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

// --- LINE Webhook ---
// ต้องอยู่ก่อน express.json() เพราะต้องอ่าน body แบบ raw (Buffer) เพื่อตรวจลายเซ็นของ LINE ก่อน
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (channelSecret && !verifySignature(req.body, signature, channelSecret)) {
    console.warn('LINE webhook signature ไม่ถูกต้อง');
    return res.status(401).end();
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf-8'));
  } catch {
    return res.status(400).end();
  }

  // ตอบ LINE ก่อนทันที ไม่ต้องรอประมวลผลเสร็จ (LINE ต้องการ response ไว เดี๋ยว retry)
  res.status(200).end();

  for (const event of body.events || []) {
    handleLineEvent(event).catch((err) => console.error('handleLineEvent error:', err));
  }
});

async function handleLineEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    if (text === 'ลงทะเบียนผู้อนุมัติ') {
      await prisma.role.upsert({
        where: { role: 'commander' },
        update: { lineUserId: userId },
        create: { role: 'commander', lineUserId: userId },
      });
      await replyMessage(event.replyToken, [
        { type: 'text', text: '✅ ลงทะเบียนเป็นผู้อนุมัติ (ผบ.หน่วย) เรียบร้อยแล้ว\nจะได้รับแจ้งเตือนเมื่อมีคำขอเบิกเงินใหม่เข้ามา' },
      ]);
      return;
    }

    if (text === 'ลงทะเบียนการเงิน') {
      await prisma.role.upsert({
        where: { role: 'finance' },
        update: { lineUserId: userId },
        create: { role: 'finance', lineUserId: userId },
      });
      await replyMessage(event.replyToken, [
        { type: 'text', text: '✅ ลงทะเบียนเป็นเจ้าหน้าที่การเงินเรียบร้อยแล้ว (ยังใช้งานเต็มรูปแบบไม่ได้จนกว่าจะสร้างขั้นตอน ③)' },
      ]);
      return;
    }
    return; // ข้อความอื่นๆ ไม่ตอบกลับ
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    const id = parseInt(params.get('id'), 10);
    if (!action || !id) return;

    const commanderRole = await prisma.role.findUnique({ where: { role: 'commander' } });
    if (!commanderRole || commanderRole.lineUserId !== userId) {
      await replyMessage(event.replyToken, [{ type: 'text', text: 'ขออภัย คุณไม่ได้เป็นผู้มีสิทธิ์อนุมัติคำขอนี้' }]);
      return;
    }

    const request = await prisma.request.findUnique({ where: { id } });
    if (!request) {
      await replyMessage(event.replyToken, [{ type: 'text', text: 'ไม่พบคำขอนี้ในระบบ' }]);
      return;
    }
    if (request.status !== 'pending_approval') {
      await replyMessage(event.replyToken, [
        { type: 'text', text: `คำขอ ${request.requestNo} ถูกดำเนินการไปแล้ว (สถานะ: ${request.status})` },
      ]);
      return;
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const updated = await prisma.request.update({ where: { id }, data: { status: newStatus } });
    const amountText = `฿ ${Number(updated.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text:
          action === 'approve'
            ? `✅ อนุมัติคำขอ ${updated.requestNo} แล้ว\nจำนวนเงิน ${amountText}`
            : `❌ ไม่อนุมัติคำขอ ${updated.requestNo}`,
      },
    ]);

    if (updated.lineUserId) {
      await pushMessage(updated.lineUserId, [
        {
          type: 'text',
          text:
            action === 'approve'
              ? `📢 คำขอเบิกเงิน ${updated.requestNo} ของคุณได้รับการอนุมัติแล้ว\nขั้นตอนถัดไป: รอเจ้าหน้าที่การเงินติดต่อเพื่อจ่ายเงิน`
              : `📢 คำขอเบิกเงิน ${updated.requestNo} ของคุณไม่ได้รับการอนุมัติ`,
        },
      ]);
    }
  }
}

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

    // ขั้นตอน ② — แจ้งเตือน ผบ.หน่วย ทันทีด้วยข้อความที่มีปุ่มอนุมัติ/ไม่อนุมัติในตัว
    const commanderRole = await prisma.role.findUnique({ where: { role: 'commander' } });
    if (commanderRole?.lineUserId) {
      await pushMessage(commanderRole.lineUserId, [buildApprovalFlex(created)]);
    } else {
      console.warn('ยังไม่มีผู้อนุมัติลงทะเบียนไว้ — ข้ามการแจ้งเตือน (คำขอยังบันทึกไว้ปกติ รออนุมัติทีหลังได้)');
    }

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
