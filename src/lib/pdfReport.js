import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansThai.ttf');

const STATUS_LABEL = {
  pending_approval: 'รออนุมัติ',
  rejected: 'ไม่อนุมัติ',
  approved: 'รอจ่ายเงิน',
  paid: 'รอหลักฐาน',
  settled: 'ปิดเรื่องแล้ว',
};

function money(n) {
  return `${Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท`;
}

function thaiDateTimeNow() {
  return new Date().toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' });
}

// สร้าง PDF รายงาน แล้วสตรีมตรงเข้า outputStream (เช่น response ของ Express) — เรียกใน route โดยตรง
export function generateReportPdf(report, outputStream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(outputStream);

  doc.registerFont('thai', FONT_PATH);
  doc.font('thai');

  const bottom = () => doc.page.height - doc.page.margins.bottom;
  function newPage() {
    doc.addPage();
    doc.font('thai');
  }
  function ensureSpace(height) {
    if (doc.y + height > bottom()) newPage();
  }

  // --- หัวเอกสาร ---
  doc.fontSize(18).fillColor('#1E2A22').text('รายงานสรุปค่าใช้จ่าย (ธุรการ)');
  doc.fontSize(13).fillColor('#555555').text(report.label);
  doc.fontSize(9).fillColor('#999999').text(`พิมพ์เมื่อ ${thaiDateTimeNow()}`);
  doc.fillColor('#000000');
  doc.moveDown(1.2);

  // --- สรุปยอด ---
  doc.fontSize(12);
  doc.text(`ยอดเบิกรวม: ${money(report.totalRequested)}`);
  doc.text(`ยอดใช้จริง (ปิดเรื่องแล้ว): ${money(report.totalActual)}`);
  doc.text(`จำนวนคำขอ: ${report.count} รายการ`);
  doc.moveDown(1);

  // --- แยกตามสถานะ ---
  if (report.byStatus && Object.keys(report.byStatus).length) {
    ensureSpace(60);
    doc.fontSize(13).text('แยกตามสถานะ', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10);
    Object.entries(report.byStatus).forEach(([status, count]) => {
      doc.text(`•  ${STATUS_LABEL[status] || status}:  ${count} รายการ`);
    });
    doc.moveDown(1);
  }

  // --- แยกตามหมวดหมู่ ---
  if (report.byCategory && report.byCategory.length) {
    ensureSpace(60);
    doc.fontSize(13).text('แยกตามหมวดหมู่', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10);
    report.byCategory.forEach((c) => {
      ensureSpace(18);
      doc.text(`•  ${c.category}:  ${money(c.amount)}  (${c.count} รายการ)`);
    });
    doc.moveDown(1);
  }

  // --- รายการทั้งหมด ---
  if (report.requests && report.requests.length) {
    ensureSpace(60);
    doc.fontSize(13).text('รายการทั้งหมด', { underline: true });
    doc.moveDown(0.4);

    report.requests.forEach((r, i) => {
      ensureSpace(45);
      doc.fontSize(10).fillColor('#000000')
        .text(`${i + 1}. ${r.requestNo} — ${r.requesterName} — ${r.category}`);
      doc.fontSize(9).fillColor('#555555')
        .text(`    จำนวนเงิน ${money(r.amount)}   สถานะ: ${STATUS_LABEL[r.status] || r.status}`);
      doc.moveDown(0.5);
    });
    doc.fillColor('#000000');
  }

  // --- ช่องลงชื่อ ---
  ensureSpace(120);
  doc.moveDown(2);
  const sigY = doc.y;
  const colWidth = 220;
  doc.fontSize(10);
  doc.text('ลงชื่อ ....................................................', 50, sigY);
  doc.text('ผู้จัดทำรายงาน', 50, sigY + 18);
  doc.text('วันที่ ..............................', 50, sigY + 36);

  doc.text('ลงชื่อ ....................................................', 50 + colWidth + 30, sigY);
  doc.text('ผบ.หน่วย (ผู้ตรวจสอบ/รับทราบ)', 50 + colWidth + 30, sigY + 18);
  doc.text('วันที่ ..............................', 50 + colWidth + 30, sigY + 36);

  doc.end();
}
