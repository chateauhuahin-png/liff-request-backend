const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function toBangkok(date) {
  return new Date(date.getTime() + BANGKOK_OFFSET_MS);
}
function fromBangkok(date) {
  return new Date(date.getTime() - BANGKOK_OFFSET_MS);
}
function formatBkkDate(utcInstant) {
  const b = toBangkok(utcInstant);
  return `${b.getUTCDate()} ${THAI_MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear() + 543}`;
}

// คำนวณช่วงเวลาของรายงาน (start = รวม, end = ไม่รวม) อิงเวลาไทย (UTC+7)
export function getReportRange(period, refDate = new Date()) {
  const bkk = toBangkok(refDate);
  const y = bkk.getUTCFullYear();
  const m = bkk.getUTCMonth();
  const d = bkk.getUTCDate();
  const dow = bkk.getUTCDay(); // 0=อาทิตย์ .. 6=เสาร์

  let startBkk, endBkk, label;

  if (period === 'daily') {
    startBkk = new Date(Date.UTC(y, m, d));
    endBkk = new Date(Date.UTC(y, m, d + 1));
  } else if (period === 'weekly') {
    const diffToMonday = (dow + 6) % 7; // จำนวนวันย้อนไปถึงวันจันทร์
    startBkk = new Date(Date.UTC(y, m, d - diffToMonday));
    endBkk = new Date(Date.UTC(y, m, d - diffToMonday + 7));
  } else if (period === 'monthly') {
    startBkk = new Date(Date.UTC(y, m, 1));
    endBkk = new Date(Date.UTC(y, m + 1, 1));
  } else if (period === 'yearly') {
    startBkk = new Date(Date.UTC(y, 0, 1));
    endBkk = new Date(Date.UTC(y + 1, 0, 1));
  } else {
    throw new Error(`unknown period: ${period}`);
  }

  const start = fromBangkok(startBkk);
  const end = fromBangkok(endBkk);

  if (period === 'daily') {
    label = `วันที่ ${formatBkkDate(start)}`;
  } else if (period === 'weekly') {
    label = `สัปดาห์นี้ (${formatBkkDate(start)} - ${formatBkkDate(new Date(end.getTime() - 1))})`;
  } else if (period === 'monthly') {
    label = `เดือน${formatBkkDate(start).split(' ').slice(1).join(' ')}`;
  } else {
    label = `ปี ${toBangkok(start).getUTCFullYear() + 543}`;
  }

  return { start, end, label };
}

// สรุปรายงานของช่วงเวลาที่กำหนด — ใช้ทั้งจาก endpoint /reports และคำสั่งพิมพ์ในแชท
export async function getReport(prisma, period, refDate = new Date()) {
  const { start, end, label } = getReportRange(period, refDate);

  const requests = await prisma.request.findMany({
    where: { createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: 'asc' },
  });

  const totalRequested = requests.reduce((sum, r) => sum + Number(r.amount), 0);
  const settled = requests.filter((r) => r.status === 'settled');
  const totalActual = settled.reduce((sum, r) => sum + Number(r.actualAmount ?? r.amount), 0);

  const byCategoryMap = {};
  for (const r of requests) {
    if (!byCategoryMap[r.category]) byCategoryMap[r.category] = { category: r.category, amount: 0, count: 0 };
    byCategoryMap[r.category].amount += Number(r.amount);
    byCategoryMap[r.category].count += 1;
  }
  const byCategory = Object.values(byCategoryMap).sort((a, b) => b.amount - a.amount);

  const byStatus = {};
  for (const r of requests) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }

  return {
    period,
    label,
    rangeStart: start,
    rangeEnd: end,
    count: requests.length,
    totalRequested,
    totalActual,
    byCategory,
    byStatus,
    requests,
  };
}
