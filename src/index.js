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
import { verifySignature, pushMessage, replyMessage, buildApprovalFlex, buildReportFlex } from './lib/line.js';
import { getReport } from './lib/report.js';
import { generateReportPdf } from './lib/pdfReport.js';
import { PERSONNEL } from './data/personnel.js';

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
        { type: 'text', text: '✅ ลงทะเบียนเป็นเจ้าหน้าที่การเงินเรียบร้อยแล้ว\nจะได้รับลิงก์ฟอร์มจ่ายเงินเมื่อคำขอได้รับอนุมัติ' },
      ]);
      return;
    }

    const REPORT_COMMANDS = {
      'รายงานวันนี้': 'daily',
      'รายงานสัปดาห์นี้': 'weekly',
      'รายงานเดือนนี้': 'monthly',
      'รายงานปีนี้': 'yearly',
    };
    if (REPORT_COMMANDS[text]) {
      const report = await getReport(prisma, REPORT_COMMANDS[text]);
      const backendBaseUrl = process.env.BACKEND_BASE_URL;
      await replyMessage(event.replyToken, [buildReportFlex(report, process.env.FRONTEND_LIFF_ID, backendBaseUrl)]);
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

    // ขั้นตอน ③ — พออนุมัติแล้ว แจ้ง น.การเงิน พร้อมลิงก์ฟอร์มจ่ายเงินของคำขอนี้โดยเฉพาะ
    if (action === 'approve') {
      const financeRole = await prisma.role.findUnique({ where: { role: 'finance' } });
      const liffId = process.env.FRONTEND_LIFF_ID;
      if (financeRole?.lineUserId && liffId) {
        const amountText = `฿ ${Number(updated.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
        await pushMessage(financeRole.lineUserId, [
          {
            type: 'text',
            text:
              `💰 มีคำขอเบิกเงินที่ได้รับอนุมัติแล้ว รอจ่ายเงิน\n` +
              `${updated.requestNo} — ${updated.requesterName}\n` +
              `จำนวนเงิน ${amountText}\n\n` +
              `กดลิงก์เพื่อบันทึกการจ่ายเงิน:\n` +
              `https://liff.line.me/${liffId}?requestId=${updated.id}`,
          },
        ]);
      } else if (!financeRole?.lineUserId) {
        console.warn('ยังไม่มีเจ้าหน้าที่การเงินลงทะเบียนไว้ — ข้ามการแจ้งเตือน');
      }
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

// คำขอรายตัว — ใช้โดยฟอร์มจ่ายเงิน (ขั้นตอน ③) เพื่อโชว์รายละเอียดก่อนจ่าย
app.get('/requests/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const request = await prisma.request.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
    res.json(request);
  } catch (err) {
    console.error('GET /requests/:id failed:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์' });
  }
});

// ขั้นตอน ③ — น.การเงิน บันทึกว่าจ่ายเงินแล้ว (เงินสด/โอน) พร้อมแนบหลักฐาน
app.post('/requests/:id/pay', upload.single('proof'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { paymentMethod, financeUserId } = req.body;

    if (!paymentMethod || !['cash', 'transfer'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'กรุณาเลือกวิธีจ่าย (เงินสด/เงินโอน)' });
    }

    const request = await prisma.request.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
    if (request.status !== 'approved') {
      return res.status(400).json({ error: `คำขอนี้ยังไม่พร้อมจ่ายเงิน (สถานะปัจจุบัน: ${request.status})` });
    }

    const updated = await prisma.request.update({
      where: { id },
      data: {
        status: 'paid',
        paymentMethod,
        paidAt: new Date(),
        paymentProofName: req.file ? req.file.originalname : null,
        paymentProofUrl: req.file ? `/uploads/${req.file.filename}` : null,
        paidByLineUserId: financeUserId || null,
      },
    });

    // แจ้งผู้ขอเบิกว่าจ่ายเงินแล้ว พร้อมลิงก์ฟอร์มส่งหลักฐานการใช้จ่ายจริง (ขั้นตอน ④)
    if (updated.lineUserId) {
      const methodText = paymentMethod === 'cash' ? 'เงินสด' : 'เงินโอน';
      const liffId = process.env.FRONTEND_LIFF_ID;
      const settleLink = liffId ? `\n\nกดลิงก์นี้เพื่อส่งหลักฐานการใช้จ่ายตอนใช้เงินเสร็จ:\nhttps://liff.line.me/${liffId}?settleId=${updated.id}` : '';
      await pushMessage(updated.lineUserId, [
        {
          type: 'text',
          text:
            `💵 คำขอเบิกเงิน ${updated.requestNo} ได้รับการจ่ายเงินแล้ว (${methodText})` +
            settleLink,
        },
      ]);
    }

    res.json({ requestNo: updated.requestNo, status: updated.status });
  } catch (err) {
    console.error('POST /requests/:id/pay failed:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
  }
});

// ขั้นตอน ④ — ผู้ขอเบิก ส่งหลักฐานการใช้จ่ายจริง ปิดเรื่อง
app.post('/requests/:id/settle', upload.single('receipt'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { actualAmount, note } = req.body;

    if (!actualAmount || parseFloat(actualAmount) < 0) {
      return res.status(400).json({ error: 'กรุณากรอกยอดใช้จ่ายจริงให้ถูกต้อง' });
    }

    const request = await prisma.request.findUnique({ where: { id } });
    if (!request) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
    if (request.status !== 'paid') {
      return res.status(400).json({ error: `คำขอนี้ยังไม่พร้อมปิดเรื่อง (สถานะปัจจุบัน: ${request.status})` });
    }

    const updated = await prisma.request.update({
      where: { id },
      data: {
        status: 'settled',
        actualAmount: parseFloat(actualAmount),
        settlementNote: note || null,
        settlementProofName: req.file ? req.file.originalname : null,
        settlementProofUrl: req.file ? `/uploads/${req.file.filename}` : null,
        settledAt: new Date(),
      },
    });

    const requestedAmt = Number(updated.amount);
    const actualAmt = Number(updated.actualAmount);
    const diff = requestedAmt - actualAmt;
    let diffText = 'ใช้จ่ายพอดีตามที่เบิก';
    if (diff > 0) diffText = `เหลือคืน ฿${diff.toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
    if (diff < 0) diffText = `ใช้เกินไป ฿${Math.abs(diff).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

    // แจ้งผู้ขอเบิกว่าปิดเรื่องสำเร็จ
    if (updated.lineUserId) {
      await pushMessage(updated.lineUserId, [
        { type: 'text', text: `✅ ปิดเรื่องคำขอ ${updated.requestNo} เรียบร้อยแล้ว\nยอดใช้จริง ฿${actualAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })} (${diffText})\n\nขอบคุณครับ/ค่ะ` },
      ]);
    }

    // แจ้ง น.การเงิน ไว้เป็นข้อมูลประกอบบัญชี (โดยเฉพาะถ้ามีส่วนต่างต้องเรียกเก็บ/จ่ายเพิ่ม)
    const financeRole = await prisma.role.findUnique({ where: { role: 'finance' } });
    if (financeRole?.lineUserId) {
      await pushMessage(financeRole.lineUserId, [
        {
          type: 'text',
          text:
            `📋 คำขอ ${updated.requestNo} (${updated.requesterName}) ส่งหลักฐานปิดเรื่องแล้ว\n` +
            `เบิกไป ฿${requestedAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })} — ใช้จริง ฿${actualAmt.toLocaleString('th-TH', { minimumFractionDigits: 2 })}\n` +
            `${diffText}`,
        },
      ]);
    }

    res.json({ requestNo: updated.requestNo, status: updated.status, diff });
  } catch (err) {
    console.error('POST /requests/:id/settle failed:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
  }
});

// รายงานสรุปค่าใช้จ่าย — ใช้โดยหน้ารายงานแบบเต็ม (?report=daily|weekly|monthly|yearly)
app.get('/reports', async (req, res) => {
  try {
    const period = req.query.period;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(period)) {
      return res.status(400).json({ error: 'period ต้องเป็น daily, weekly, monthly หรือ yearly' });
    }
    const report = await getReport(prisma, period);
    res.json(report);
  } catch (err) {
    console.error('GET /reports failed:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์' });
  }
});

// ดาวน์โหลดรายงานเป็นไฟล์ PDF จริง — เชื่อถือได้กว่าใช้ print ของเบราว์เซอร์ เปิด/แชร์ผ่าน LINE ได้ตรงๆ
app.get('/reports/pdf', async (req, res) => {
  try {
    const period = req.query.period;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(period)) {
      return res.status(400).json({ error: 'period ต้องเป็น daily, weekly, monthly หรือ yearly' });
    }
    const report = await getReport(prisma, period);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report-${period}.pdf"`);
    generateReportPdf(report, res);
  } catch (err) {
    console.error('GET /reports/pdf failed:', err);
    res.status(500).json({ error: 'สร้าง PDF ไม่สำเร็จ' });
  }
});

// รายชื่อกำลังพล — ใช้เติม dropdown ในฟอร์มขอเบิกเงิน (แก้ไขรายชื่อได้ที่ src/data/personnel.js)
app.get('/personnel', (req, res) => {
  res.json(PERSONNEL);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`liff-request-backend listening on port ${port}`);
});
