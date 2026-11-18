import jwt from "jsonwebtoken";

export function generateToken(user) {
  const payload = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "user",
  };

  // Thêm các trường tùy chọn nếu có (ví dụ: isImpersonation, impersonatedBy)
  if (user.isImpersonation !== undefined) {
    payload.isImpersonation = user.isImpersonation;
  }
  if (user.impersonatedBy) {
    payload.impersonatedBy = user.impersonatedBy;
  }

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}
