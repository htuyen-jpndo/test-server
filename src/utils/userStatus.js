export const USER_STATUS = Object.freeze({
  ACTIVE: "active",
  SUSPENDED: "suspended",
});

export function parseUserStatus(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return Object.values(USER_STATUS).includes(normalized) ? normalized : null;
}

export function isUserSuspended(user) {
  return parseUserStatus(user?.status) === USER_STATUS.SUSPENDED;
}

export function sendSuspendedAccountResponse(res) {
  return res.status(403).json({
    error:
      "恐れ入りますが、お客様のアカウントは一時停止されております。ご不明な点がございましたらサポートまでお問い合わせください。",
    message:
      "恐れ入りますが、お客様のアカウントは一時停止されております。ご不明な点がございましたらサポートまでお問い合わせください。",
    status: USER_STATUS.SUSPENDED,
  });
}
