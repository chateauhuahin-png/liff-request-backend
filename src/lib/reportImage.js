import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(__dirname, '..', '..', 'assets', 'fonts', 'NotoSansThai.ttf');
const FONT_BASE64 = fs.readFileSync(FONT_PATH).toString('base64');

const STATUS_LABEL = {
  pending_approval: 'รออนุมัติ',
  rejected: 'ไม่อนุมัติ',
  approved: 'รอจ่ายเงิน',
  paid: 'รอหลักฐาน',
  settled: 'ปิดเรื่องแล้ว',
};

function money(n) {
  return `฿ ${Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// สร้างรูปภาพสรุปรายงาน (PNG) — ใช้ส่งเป็น LINE image message เข้าแชทโดยตรง
export async function generateReportImage(report) {
  const W = 800;
  const PAD = 40;
  const categories = (report.byCategory || []).slice(0, 6);
  const maxCatAmount = categories.length ? Math.max(...categories.map((c) => c.amount)) : 0;
  const statusEntries = Object.entries(report.byStatus || {});

  const headerH = 150;
  const statsH = 130;
  const statusH = statusEntries.length ? 40 + statusEntries.length * 30 : 0;
  const catH = categories.length ? 50 + categories.length * 46 : 0;
  const footerH = 50;
  const H = headerH + statsH + statusH + catH + footerH + PAD;

  let y = headerH;

  const statsSvg = `
    <rect x="${PAD}" y="${y}" width="${(W - PAD * 2 - 20) / 2}" height="90" rx="10" fill="#EEF0E9"/>
    <text x="${PAD + 18}" y="${y + 30}" font-size="13" fill="#63705F">ยอดเบิกรวม</text>
    <text x="${PAD + 18}" y="${y + 62}" font-size="24" font-weight="bold" fill="#1E2A22">${esc(money(report.totalRequested))}</text>

    <rect x="${PAD + (W - PAD * 2 - 20) / 2 + 20}" y="${y}" width="${(W - PAD * 2 - 20) / 2}" height="90" rx="10" fill="#EEF0E9"/>
    <text x="${PAD + (W - PAD * 2 - 20) / 2 + 38}" y="${y + 30}" font-size="13" fill="#63705F">ยอดใช้จริง (ปิดเรื่องแล้ว)</text>
    <text x="${PAD + (W - PAD * 2 - 20) / 2 + 38}" y="${y + 62}" font-size="24" font-weight="bold" fill="#1F6E43">${esc(money(report.totalActual))}</text>

    <text x="${PAD}" y="${y + 120}" font-size="14" fill="#63705F">จำนวนคำขอทั้งหมด: <tspan font-weight="bold" fill="#1E2A22">${report.count} รายการ</tspan></text>
  `;
  y += statsH;

  let statusSvg = '';
  if (statusEntries.length) {
    statusSvg += `<text x="${PAD}" y="${y}" font-size="15" font-weight="bold" fill="#1E2A22">แยกตามสถานะ</text>`;
    y += 28;
    for (const [status, count] of statusEntries) {
      statusSvg += `<text x="${PAD}" y="${y}" font-size="14" fill="#1E2A22">•  ${esc(STATUS_LABEL[status] || status)}:  ${count} รายการ</text>`;
      y += 30;
    }
    y += 10;
  }

  let catSvg = '';
  if (categories.length) {
    catSvg += `<text x="${PAD}" y="${y}" font-size="15" font-weight="bold" fill="#1E2A22">แยกตามหมวดหมู่</text>`;
    y += 30;
    const barMaxW = W - PAD * 2;
    for (const c of categories) {
      catSvg += `<text x="${PAD}" y="${y}" font-size="13" fill="#1E2A22">${esc(c.category)}</text>`;
      catSvg += `<text x="${W - PAD}" y="${y}" font-size="13" text-anchor="end" font-weight="bold" fill="#1E2A22">${esc(money(c.amount))}</text>`;
      y += 10;
      const barW = maxCatAmount ? (c.amount / maxCatAmount) * barMaxW : 0;
      catSvg += `<rect x="${PAD}" y="${y}" width="${barMaxW}" height="8" rx="4" fill="#EEF0E9"/>`;
      catSvg += `<rect x="${PAD}" y="${y}" width="${barW}" height="8" rx="4" fill="#B0821E"/>`;
      y += 36;
    }
  }

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <style>
      @font-face { font-family: 'Thai'; src: url(data:font/ttf;base64,${FONT_BASE64}) format('truetype'); }
      text { font-family: 'Thai'; }
    </style>
    <rect width="100%" height="100%" fill="#FFFFFF"/>
    <rect x="0" y="0" width="100%" height="${headerH}" fill="#1E2A22"/>
    <text x="${PAD}" y="55" font-size="22" font-weight="bold" fill="#FFFFFF">รายงานสรุปค่าใช้จ่าย</text>
    <text x="${PAD}" y="88" font-size="16" fill="#D4B15A">${esc(report.label)}</text>
    <text x="${PAD}" y="115" font-size="12" fill="#B7C0B4">ธุรการ</text>
    ${statsSvg}
    ${statusSvg}
    ${catSvg}
    <text x="${PAD}" y="${H - 18}" font-size="11" fill="#999999">ดูรายละเอียดฉบับเต็ม/ดาวน์โหลด PDF ได้จากปุ่มด้านบน</text>
  </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
