import crypto from "crypto";

/**
 * Bảo vệ URL server-to-server (GET /api/payment/callback) khỏi bị gọi giả mạo.
 *
 * Nhiều cổng (J-Payment / link式) khi gọi notify chỉ nối thêm ?gid=&rst=&cod=... và **không giữ**
 * query `?s=` bạn cấu hình sẵn → `s` bị mất → 403. Vì vậy hỗ trợ thêm secret trong **path**:
 *
 *   https://api.example.com/api/payment/callback/YOUR_LONG_RANDOM_SECRET
 *   (cổng vẫn nối ?gid=...&rst=... sau path)
 *
 * Hoặc query (nếu cổng giữ nguyên URL đầy đủ):
 *   https://api.example.com/api/payment/callback?s=YOUR_LONG_RANDOM_SECRET
 *
 * Env: JPAYMENT_CALLBACK_QUERY_SECRET=YOUR_LONG_RANDOM_SECRET
 *
 * Nếu env không set → không chặn (tương thích bản cũ).
 */
export function verifyJPaymentCallbackQuerySecret(req) {
  const secret = (process.env.JPAYMENT_CALLBACK_QUERY_SECRET || "").trim();
  if (!secret) return;

  const q = req.query || {};
  const fromQuery = q.s != null ? String(q.s).trim() : "";
  const fromPath =
    req.params?.notifyToken != null ? String(req.params.notifyToken).trim() : "";
  const provided = fromQuery || fromPath;

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error("Forbidden: invalid notify secret");
    err.statusCode = 403;
    throw err;
  }
}
