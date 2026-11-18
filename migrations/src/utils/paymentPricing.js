function toIntOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * Base amount for "unused period" proration: prefer the price actually on the order (expectedAmount / am);
 * if missing, fall back to list price. Avoids crediting a wrong amount when env prices or catalog changed.
 */
export function resolveBilledBaseForProration(order) {
  if (!order) return null;
  const fromOrder = toIntOrNull(order.expectedAmount) ?? toIntOrNull(order.am);
  if (fromOrder != null && fromOrder > 0) return fromOrder;
  return getPlanAmount(order.planType, order.accountType);
}

export function getPlanAmount(planType, accountType) {
  const defaults = {
    monthly: { personal: 1320, company: 2980 },
    yearly: { personal: 14520, company: 32780 },
    trial: { personal: 1000, company: null },
  };
  const envMap = {
    monthly: {
      personal: process.env.PAYMENT_PRICE_MONTHLY_PERSONAL,
      company: process.env.PAYMENT_PRICE_MONTHLY_COMPANY,
    },
    yearly: {
      personal: process.env.PAYMENT_PRICE_YEARLY_PERSONAL,
      company: process.env.PAYMENT_PRICE_YEARLY_COMPANY,
    },
    trial: {
      personal: process.env.PAYMENT_PRICE_TRIAL_PERSONAL,
      company: process.env.PAYMENT_PRICE_TRIAL_COMPANY,
    },
  };
  const fromEnv = toIntOrNull(envMap?.[planType]?.[accountType]);
  if (fromEnv != null && fromEnv >= 0) return fromEnv;
  return defaults?.[planType]?.[accountType] ?? null;
}

/**
 * J-Payment 等の「オンライン決済下限」がないと ER017(下限金額)になり得る。0 = 未使用。
 */
export function getMinOnlineChargeJpy() {
  const n = toIntOrNull(process.env.PAYMENT_MIN_ONLINE_CHARGE_JPY);
  return n != null && n > 0 ? n : 0;
}
