import crypto from 'crypto';

const LINE_API = 'https://api.line.me/v2/bot';

// ตรวจสอบว่า webhook นี้มาจาก LINE จริง (ป้องกันคนปลอมส่ง request มาที่ /webhook)
export function verifySignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const hash = crypto.createHmac('SHA256', channelSecret).update(rawBody).digest('base64');
  return hash === signature;
}

async function callLineApi(path, payload) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn(`LINE_CHANNEL_ACCESS_TOKEN ยังไม่ได้ตั้งค่า — ข้ามการส่งข้อความ (${path})`);
    return;
  }
  const res = await fetch(`${LINE_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`LINE API ${path} failed:`, res.status, await res.text());
  }
}

export function pushMessage(userId, messages) {
  return callLineApi('/message/push', { to: userId, messages });
}

export function replyMessage(replyToken, messages) {
  return callLineApi('/message/reply', { replyToken, messages });
}

function formatThaiDate(date) {
  const d = new Date(date);
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear() + 543}`;
}

const STATUS_LABEL = {
  pending_approval: 'รออนุมัติ',
  rejected: 'ไม่อนุมัติ',
  approved: 'รอจ่ายเงิน',
  paid: 'รอหลักฐาน',
  settled: 'ปิดเรื่องแล้ว',
};

// สร้างข้อความ Flex สรุปรายงาน ส่งตอบตอนพิมพ์คำสั่ง "รายงานวันนี้" ฯลฯ
export function buildReportFlex(report, liffId) {
  const money = (n) => `฿ ${Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

  const statusLines = Object.entries(report.byStatus).map(([status, count]) =>
    row(STATUS_LABEL[status] || status, `${count} รายการ`)
  );

  const categoryLines = report.byCategory
    .slice(0, 5)
    .map((c) => row(c.category, `${money(c.amount)} (${c.count})`));

  const contents = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1E2A22',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: 'รายงานสรุปค่าใช้จ่าย', color: '#FFFFFF', weight: 'bold', size: 'md' },
        { type: 'text', text: report.label, color: '#D4B15A', size: 'sm', margin: 'sm' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        row('จำนวนคำขอ', `${report.count} รายการ`),
        row('ยอดเบิกรวม', money(report.totalRequested)),
        row('ยอดใช้จริง (ปิดเรื่องแล้ว)', money(report.totalActual)),
        { type: 'separator', margin: 'md' },
        ...(statusLines.length ? statusLines : [row('สถานะ', 'ไม่มีคำขอในช่วงนี้')]),
        ...(categoryLines.length ? [{ type: 'separator', margin: 'md' }, ...categoryLines] : []),
      ],
    },
  };

  if (liffId) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#1E2A22',
          action: {
            type: 'uri',
            label: '📊 ดูรายงานแบบเต็ม',
            uri: `https://liff.line.me/${liffId}?report=${report.period}`,
          },
        },
      ],
    };
  }

  return {
    type: 'flex',
    altText: `รายงานสรุปค่าใช้จ่าย ${report.label} — ยอดเบิกรวม ${money(report.totalRequested)}`,
    contents,
  };
}

function row(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    contents: [
      { type: 'text', text: label, color: '#63705F', size: 'sm', flex: 2 },
      { type: 'text', text: String(value), color: '#1E2A22', size: 'sm', flex: 3, wrap: true },
    ],
  };
}

// สร้างข้อความ Flex ที่มีปุ่มอนุมัติ/ไม่อนุมัติในตัว ส่งไปหา ผบ.หน่วย ตอนมีคำขอใหม่
export function buildApprovalFlex(request) {
  const amountText = `฿ ${Number(request.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`;

  return {
    type: 'flex',
    altText: `คำขอเบิกเงินใหม่ ${request.requestNo} จาก ${request.requesterName} จำนวน ${amountText}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1E2A22',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'คำขอเบิกเงินใหม่', color: '#FFFFFF', weight: 'bold', size: 'md' },
          { type: 'text', text: request.requestNo, color: '#D4B15A', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          row('ผู้ขอเบิก', request.requesterName),
          row('หน่วยงาน', request.unit),
          row('วัตถุประสงค์', request.purpose),
          row('หมวดหมู่', request.category),
          row('จำนวนเงิน', amountText),
          row('ต้องการใช้ภายใน', formatThaiDate(request.neededDate)),
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#1F6E43',
            action: {
              type: 'postback',
              label: '✅ อนุมัติ',
              data: `action=approve&id=${request.id}`,
              displayText: `อนุมัติคำขอ ${request.requestNo}`,
            },
          },
          {
            type: 'button',
            style: 'primary',
            color: '#A6382F',
            action: {
              type: 'postback',
              label: '❌ ไม่อนุมัติ',
              data: `action=reject&id=${request.id}`,
              displayText: `ไม่อนุมัติคำขอ ${request.requestNo}`,
            },
          },
        ],
      },
    },
  };
}
