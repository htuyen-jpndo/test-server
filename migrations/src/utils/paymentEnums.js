export const PAYMENT_METHOD = {
  CREDIT_CARD: "CREDIT_CARD",
  BANK_TRANSFER: "BANK_TRANSFER",
  FREE: "FREE",
};

export function parsePaymentMethod(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toUpperCase();
  if (s === "CREDIT_CARD" || s === "CARD") return PAYMENT_METHOD.CREDIT_CARD;
  if (s === "BANK_TRANSFER" || s === "BANK" || s === "TRANSFER" || s === "銀行振込")
    return PAYMENT_METHOD.BANK_TRANSFER;
  if (s === "FREE" || s === "決済免除") return PAYMENT_METHOD.FREE;
  return null;
}
