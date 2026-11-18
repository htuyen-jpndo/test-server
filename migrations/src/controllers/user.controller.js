import { User } from "../models/user.model.js";
import { UserPaymentCancellation } from "../models/userPaymentCancellation.model.js";
import bcrypt from "bcryptjs";
import { generateToken } from "../utils/jwt.js";
import { sendMail } from "../utils/mailer.js";
import {
  getLatestPaidForUser,
  getLatestPendingForUser,
  toPaymentProfilePayload,
} from "../utils/paymentProfile.js";
import { getUserSubscriptionState } from "../middlewares/subscription.middleware.js";
import { isUserSuspended, sendSuspendedAccountResponse } from "../utils/userStatus.js";

function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildResetEmail(name, email, code) {
  const subject = "パスワード再設定用認証コードのご案内｜Aerolog";
  const text = [
    `平素よりAerologをご利用いただき、誠にありがとうございます。`,
    `${name ? `${name}様` : "お客様"}、`,
    "",
    "パスワード再設定のご依頼を受け付けました。",
    "以下の認証コードをご入力のうえ、パスワードの再設定を完了してください（有効期限：10分）。",
    "",
    `認証コード：${code}`,
    "",
    "本メールにお心当たりがない場合は、本メールを破棄いただきますようお願いいたします。",
    "",
    "―― Aerologサポート",
  ].join("\n");
  const html = [
    `<p>平素よりAerologをご利用いただき、誠にありがとうございます。</p>`,
    `<p>${name ? `${escapeHtml(name)}様` : "お客様"}、</p>`,
    "<p>パスワード再設定のご依頼を受け付けました。</p>",
    "<p>下記の認証コードをご入力のうえ、パスワードの再設定を完了してください（有効期限：10分）。</p>",
    `<p style="font-size:18px; font-weight:bold; letter-spacing:1px">${escapeHtml(code)}</p>`,
    "<p>本メールにお心当たりがない場合は、本メールを破棄いただきますようお願いいたします。</p>",
    "<p>今後ともAerologをよろしくお願い申し上げます。</p>",
    "<p>―― Aerologサポート</p>",
  ].join("");
  return { subject, text, html };
}

function resolveSubscriptionPlanFromState(subscription) {
  if (!subscription || subscription.status !== "active") return "none";
  const accountType = subscription.accountType;
  const planType = subscription.planType;
  if (
    (accountType === "personal" || accountType === "company") &&
    (planType === "monthly" || planType === "yearly" || planType === "trial")
  ) {
    return `${accountType}_${planType}`;
  }
  return "none";
}

export async function registerUser(req, res) {
  try {
    const { name, email: rawEmail, password } = req.body;
    const email = (rawEmail || "").trim().toLowerCase();

    if (!name || !email || !password)
      return res.status(400).json({ error: "Missing fields" });

    const existing = await User.findOne({ where: { email } });
    if (existing)
      return res.status(409).json({ error: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await User.create({
      name,
      email,
      password: hashedPassword,
    });

    res.status(201).json({
      message: "User registered",
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role || "user",
        status: newUser.status,
      },
    });

  } catch (err) {
    console.error("❌ Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
}


export async function loginUser(req, res) {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password;

    if (!email || !password)
      return res.status(400).json({ error: "Missing email or password" });

    const user = await User.findOne({ where: { email } });
    if (!user) {
      console.log("❌ Login: user not found, email=", JSON.stringify(email));
      return res.status(404).json({ error: "User not found" });
    }
    if (isUserSuspended(user)) {
      return sendSuspendedAccountResponse(res);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ error: "Invalid password" });

    const token = generateToken(user);
    const subscription = await getUserSubscriptionState(user.id);
    const mustRedirectToRoot = user.role !== "admin" && subscription.status !== "active";
    const subscriptionPlan = resolveSubscriptionPlanFromState(subscription);

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || "user",
        status: user.status,
        subscriptionPlan,
      },
      subscription,
      redirectTo: mustRedirectToRoot ? "/" : "/home",
    });

  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
}


// export async function forgotPassword(req, res) {
//   try {
//     const { email } = req.body;

//     if (!email)
//       return res.status(400).json({ error: "Email required" });

//     const user = await User.findOne({ where: { email } });

//     if (!user)
//       return res.status(404).json({ error: "Email not found" });

//     // tạo mã 6 số
//     const code = Math.floor(100000 + Math.random() * 900000).toString();

//     // lưu vào DB và hạn 10 phút
//     user.resetCode = code;
//     user.resetExpire = Date.now() + 10 * 60 * 1000;
//     await user.save();

//     await sendMail(
//       user.email,
//       "Password Reset Code",
//       `Your reset code is: ${code}`
//     );

//     res.json({ message: "Reset code sent to email" });

//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Server error" });
//   }
// }

// export async function forgotPassword(req, res) {
//   try {
//     const { email } = req.body;

//     if (!email)
//       return res.status(400).json({ error: "Email required" });

//     const user = await User.findOne({ where: { email } });

//     if (!user)
//       return res.status(404).json({ error: "Email not found" });

//     const code = Math.floor(100000 + Math.random() * 900000).toString();

//     user.resetCode = code;
//     user.resetExpire = new Date(Date.now() + 10 * 60 * 1000);
//     await user.save();

//     await sendMail(
//       user.email,
//       "Password Reset Code",
//       `Your reset code is: ${code}`
//     );

//     return res.json({ message: "Reset code sent to email" });
//   } catch (err) {
//     console.error("❌ forgotPassword error:", err);
//     return res.status(500).json({ error: err.message || "Server error" });
//   }
// }
// controller forgotPassword
export async function forgotPassword(req, res) {
  console.log(">>> /forgot-password called, body:", req.body);

  try {
    const { email } = req.body;

    if (!email)
      return res.status(400).json({ error: "Email required" });

    const user = await User.findOne({ where: { email } });

    if (!user)
      return res.status(404).json({ error: "Email not found" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    user.resetCode = code;
    user.resetExpire = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    const { subject, text, html } = buildResetEmail(user.name, user.email, code);
    await sendMail(user.email, subject, text, html);

    return res.json({ message: "Reset code sent to email" });

  } catch (err) {
    console.error("❌ forgotPassword error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Server error" }); // TRẢ RA MESSAGE THẬT
  }
}





export async function verifyResetCode(req, res) {
  try {
    const { email, code } = req.body || {};

    if (!email || !code) {
      return res.status(400).json({ error: "Missing email or code" });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.resetCode !== code) {
      return res.status(400).json({ error: "Invalid code" });
    }

    if (!user.resetExpire || user.resetExpire < Date.now()) {
      return res.status(400).json({ error: "Code expired" });
    }

    return res.json({ message: "Code valid" });
  } catch (err) {
    console.error("❌ verifyResetCode error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function resetPassword(req, res) {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword)
      return res.status(400).json({ error: "Missing fields" });

    const user = await User.findOne({ where: { email } });

    if (!user)
      return res.status(404).json({ error: "User not found" });

    if (user.resetCode !== code)
      return res.status(400).json({ error: "Invalid code" });

    if (user.resetExpire < Date.now())
      return res.status(400).json({ error: "Code expired" });

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetCode = null;
    user.resetExpire = null;

    await user.save();

    res.json({ message: "Password updated successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function getMe(req, res) {
  try {
    // req.user is injected by auth middleware and contains id, name, email
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const [latestPaid, latestPending, subscription] = await Promise.all([
      getLatestPaidForUser(req.user.id),
      getLatestPendingForUser(req.user.id),
      getUserSubscriptionState(req.user.id),
    ]);

    const payload = {
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role || "user",
        status: req.user.status,
        subscriptionPlan: resolveSubscriptionPlanFromState(subscription),
      },
      payments: {
        latestPaid: toPaymentProfilePayload(latestPaid),
        latestPending: toPaymentProfilePayload(latestPending),
      },
      subscription,
    };

    // Tương thích FE cũ: chỉ khi có đơn paid mới có `payment` (cùng shape với trước)
    if (latestPaid) {
      payload.payment = toPaymentProfilePayload(latestPaid);
    }

    res.json(payload);
  } catch (err) {
    console.error('❌ getMe error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function updateMe(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    // load user from DB to get current (old) name
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const oldName = user.name;
    user.name = name;
    await user.save();

    // Cập nhật pilot (bảng pilots) có fullName = tên cũ của user → tên mới (danh sách pilot của user này)
    try {
      const { Pilot } = await import("../models/index.js");
      await Pilot.update(
        { fullName: name },
        { where: { userId: user.id, fullName: oldName } }
      );
    } catch (e) {
      console.warn("Could not update pilot names:", e);
    }

    res.json({
      message: "Profile updated",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || "user",
        status: user.status,
      },
    });
  } catch (err) {
    console.error('❌ updateMe error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

/**
 * POST /api/users/me/payment-cancellations
 * Lưu lý do user hủy tự động gia hạn (cần JWT).
 * Body: { reason }
 */
export async function recordUserPaymentCancellation(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason is required" });
    if (reason.length > 255) return res.status(400).json({ error: "reason is too long" });

    const row = await UserPaymentCancellation.create({
      userId: req.user.id,
      note: reason,
    });

    return res.status(201).json({
      id: row.id,
      message: "Recorded",
    });
  } catch (err) {
    console.error("❌ recordUserPaymentCancellation error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
