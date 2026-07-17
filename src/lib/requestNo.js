// ออกเลขที่คำขอรูปแบบ REQ-{ปี พ.ศ.}-{ลำดับ 4 หลัก} เช่น REQ-2569-0007
export async function generateRequestNo(prisma) {
  const beYear = new Date().getFullYear() + 543;
  const prefix = `REQ-${beYear}-`;

  const count = await prisma.request.count({
    where: { requestNo: { startsWith: prefix } },
  });

  const seq = String(count + 1).padStart(4, '0');
  return `${prefix}${seq}`;
}
