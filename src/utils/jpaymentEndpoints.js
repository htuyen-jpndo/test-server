/**
 * J-Payment hosts. The real gateway is always used unless a mock is opted in.
 * JPAYMENT_MOCK is ignored when NODE_ENV=production (startup throws).
 * JPAYMENT_MOCK_BASE_URL alone does nothing — the mock flag or JPAYMENT_BASE_URL is required.
 */

export const JPAYMENT_REAL_ORIGIN = "https://credit.j-payment.co.jp";

export function isJPaymentMockEnabled() {
  const raw = String(process.env.JPAYMENT_MOCK || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function cleanOrigin(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/** Origin that checkout, acsgate, gateway.aspx, and card-change links use. */
export function jpaymentOrigin() {
  if (isJPaymentMockEnabled()) {
    return cleanOrigin(
      process.env.JPAYMENT_MOCK_BASE_URL || process.env.JPAYMENT_BASE_URL || "http://127.0.0.1:5099"
    );
  }
  const explicit = cleanOrigin(process.env.JPAYMENT_BASE_URL);
  if (explicit) return explicit;
  return JPAYMENT_REAL_ORIGIN;
}

export function assertJPaymentEndpointsAllowed() {
  const prod = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  if (!prod) return;
  if (isJPaymentMockEnabled() || jpaymentOrigin() !== JPAYMENT_REAL_ORIGIN) {
    throw new Error(
      "Refusing to start: J-Payment mock is not allowed when NODE_ENV=production. Unset JPAYMENT_MOCK and JPAYMENT_BASE_URL."
    );
  }
}

export function jpayLinkCheckoutUrl() {
  return `${jpaymentOrigin()}/link/creditcard`;
}

export function jpayGatewayUrl() {
  return `${jpaymentOrigin()}/gateway/gateway.aspx`;
}

export function jpayAutoChargeStopUrl() {
  return `${jpaymentOrigin()}/gateway/acsgate.aspx`;
}

export function jpayLinkAutoChargeUpdateUrl() {
  return `${jpaymentOrigin()}/link/creditcard/auto-charge/update`;
}

export function jpayReAuthUrl() {
  return `${jpaymentOrigin()}/gateway/re_auth.aspx`;
}
