// ตรวจสอบว่า access token ที่ฟอร์มส่งมาเป็นของจริงจาก LINE หรือไม่
// คืนค่า null ถ้า token ไม่ถูกต้อง/หมดอายุ/ไม่มี
export async function verifyLiffToken(accessToken) {
  if (!accessToken) return null;

  try {
    const res = await fetch(
      `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) return null;
    return await res.json(); // { scope, client_id, expires_in }
  } catch (err) {
    console.error('LINE token verify failed:', err);
    return null;
  }
}
