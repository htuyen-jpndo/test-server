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
 * Bắt buộc. Thiếu secret → throw. Server phải từ chối khởi động; callback không được mở.
 */
export function getJPaymentCallbackQuerySecret() {
  return (process.env.JPAYMENT_CALLBACK_QUERY_SECRET || "").trim();
}

export function assertJPaymentCallbackSecretConfigured() {
  const secret = getJPaymentCallbackQuerySecret();
  if (!secret) {
    const err = new Error(
      "JPAYMENT_CALLBACK_QUERY_SECRET is required. Refusing to start without a callback notify secret. Set a long random value and use the same value in the J-Payment notify URL (/api/payment/callback/<secret> or ?s=<secret>)."
    );
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

export function verifyJPaymentCallbackQuerySecret(req) {
  const secret = assertJPaymentCallbackSecretConfigured();

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

const REDACTED = "[REDACTED]";

/** Remove the notify secret from a URL before it is written to logs. */
export function redactPaymentCallbackUrl(url) {
  if (url == null) return url;
  let s = String(url);
  const secret = getJPaymentCallbackQuerySecret();
  if (secret) s = s.split(secret).join(REDACTED);
  s = s.replace(/([?&](?:s|notifyToken)=)[^&#]*/gi, `$1${REDACTED}`);
  s = s.replace(/(\/(?:auto-renew\/)?callback\/)[^/?#]+/gi, `$1${REDACTED}`);
  return s;
}

/** Copy a query object with the notify secret removed. Safe to persist or log. */
export function redactPaymentCallbackQuery(query) {
  const src = query && typeof query === "object" ? query : {};
  const secret = getJPaymentCallbackQuerySecret();
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === "s" || key === "notifyToken") {
      out[key] = value == null || value === "" ? value : REDACTED;
      continue;
    }
    if (typeof value === "string" && secret && secret.length > 0 && value.includes(secret)) {
      out[key] = value.split(secret).join(REDACTED);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        typeof item === "string" && secret && item.includes(secret)
          ? item.split(secret).join(REDACTED)
          : item
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}
