import { Contact } from "../models/contact.model.js";
import { sendMail } from "../utils/mailer.js";

const SUBJECT_LABELS = {
  "": "—",
  usage: "ご利用について",
  billing: "料金・お支払い",
  technical: "不具合・技術的なお問い合わせ",
  other: "その他",
};
const SOURCE_LABELS = {
  "": "—",
  search: "検索エンジン",
  sns: "SNS",
  introduction: "知人の紹介",
  other: "その他",
};

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

/** Trạng thái liên hệ (admin quản lý) */
export const CONTACT_STATUS = {
  new: "新規",
  in_progress: "対応中",
  resolved: "対応済み",
  closed: "クローズ",
};
const VALID_STATUSES = Object.keys(CONTACT_STATUS);

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || "").trim());
}
function validateTel(value) {
  const v = (value || "").trim();
  return /^[\d\-+\s()]+$/.test(v) && v.replace(/\D/g, "").length >= 10;
}

/**
 * POST /api/contacts — Gửi form liên hệ (public)
 * 
 * Body: { name, email, tel, subject?, message, source? }
 */
export async function submitContact(req, res) {
  try {
    const body = req.body || {};
    const name = (body.name || "").trim();
    const email = (body.email || "").trim();
    const tel = (body.tel || "").trim();
    const subject = (body.subject || "").trim();
    const message = (body.message || "").trim();
    const source = (body.source || "").trim();

    const errors = [];
    if (!name) errors.push("お名前を入力してください。");
    if (!email) errors.push("メールアドレスを入力してください。");
    else if (!validateEmail(email)) errors.push("有効なメールアドレスを入力してください。");
    if (!tel) errors.push("電話番号を入力してください。");
    else if (!validateTel(tel)) errors.push("有効な電話番号を入力してください。");
    if (!message) errors.push("メッセージを入力してください。");

    if (errors.length > 0) {
      return res.status(400).json({ message: errors[0], errors });
    }

    const contact = await Contact.create({
      name,
      email,
      tel,
      subject: subject || null,
      message,
      source: source || null,
    });

    const subjectLabel = SUBJECT_LABELS[subject] || subject || "—";
    const sourceLabel = SOURCE_LABELS[source] || source || "—";

    // 1) Gửi thông báo cho admin (đích đến: SUPPORT_EMAIL, nếu không có thì MAIL_USER)
    const adminEmail = process.env.SUPPORT_EMAIL || process.env.MAIL_USER;
    if (adminEmail) {
      console.log("📧 Gửi email thông báo liên hệ đến:", adminEmail);
      const adminText = [
        "サポートお問い合わせが送信されました。",
        "",
        `お名前: ${name}`,
        `メール: ${email}`,
        `電話: ${tel}`,
        `題名: ${subjectLabel}`,
        `お問い合わせのきっかけ: ${sourceLabel}`,
        "",
        "メッセージ:",
        message,
      ].join("\n");
      const adminHtml = [
        "<h2>サポートお問い合わせ</h2>",
        "<table style='border-collapse:collapse'>",
        `<tr><td style='padding:4px 8px'><b>お名前</b></td><td>${escapeHtml(name)}</td></tr>`,
        `<tr><td style='padding:4px 8px'><b>メール</b></td><td>${escapeHtml(email)}</td></tr>`,
        `<tr><td style='padding:4px 8px'><b>電話</b></td><td>${escapeHtml(tel)}</td></tr>`,
        `<tr><td style='padding:4px 8px'><b>題名</b></td><td>${escapeHtml(subjectLabel)}</td></tr>`,
        `<tr><td style='padding:4px 8px'><b>お問い合わせのきっかけ</b></td><td>${escapeHtml(sourceLabel)}</td></tr>`,
        "</table>",
        "<p><b>メッセージ:</b></p>",
        `<p style='white-space:pre-wrap'>${escapeHtml(message)}</p>`,
      ].join("");
      const mailSubject = `[お問い合わせ] ${subjectLabel} - ${name}`;
      try {
        await sendMail(adminEmail, mailSubject, adminText, adminHtml);
        console.log("✅ Email thông báo đã gửi đến admin:", adminEmail);
      } catch (mailErr) {
        console.error("❌ Contact mail notify failed:", mailErr.message || mailErr);
      }
    } else {
      console.warn("⚠️ SUPPORT_EMAIL / MAIL_USER chưa cấu hình → không gửi email thông báo.");
    }

    // 2) Gửi email xác nhận cho khách hàng
    try {
      const confirmSubject = "お問い合わせを受け付けました - エアログ";
      const confirmText = [
        `${name} 様`,
        "",
        "この度はお問い合わせいただきありがとうございます。",
        "以下の内容で受け付けました。",
        "内容を確認のうえ、担当者よりご連絡いたします。",
        "",
        "────────────────────",
        `お名前: ${name}`,
        `メール: ${email}`,
        `題名: ${subjectLabel}`,
        "",
        "メッセージ:",
        message,
        "────────────────────",
        "",
        "エアログサポート",
      ].join("\n");
      const confirmHtml = [
        `<p>${escapeHtml(name)} 様</p>`,
        "<p>この度はお問い合わせいただきありがとうございます。<br>以下の内容で受け付けました。内容を確認のうえ、担当者よりご連絡いたします。</p>",
        "<table style='border-collapse:collapse; margin:1em 0'>",
        `<tr><td style='padding:4px 8px'><b>お名前</b></td><td>${escapeHtml(name)}</td></tr>`,
        `<tr><td style='padding:4px 8px'><b>メール</b></td><td>${escapeHtml(email)}</td></tr>`,
        `<tr><td style='padding:4px 8px'><b>題名</b></td><td>${escapeHtml(subjectLabel)}</td></tr>`,
        "</table>",
        "<p><b>メッセージ:</b></p>",
        `<p style='white-space:pre-wrap'>${escapeHtml(message)}</p>`,
        "<p>— エアログサポート</p>",
      ].join("");
      await sendMail(email, confirmSubject, confirmText, confirmHtml);
      console.log("✅ Email xác nhận đã gửi cho khách:", email);
    } catch (mailErr) {
      console.error("❌ Contact confirmation mail failed:", mailErr.message || mailErr);
      // Không trả lỗi cho client — liên hệ đã lưu, chỉ thông báo gửi email xác nhận thất bại
    }

    res.status(200).json({
      message: "送信が完了しました。",
      id: contact.id,
    });
  } catch (err) {
    console.error("❌ submitContact error:", err);
    res.status(500).json({
      message: "送信に失敗しました。しばらく経ってからお試しください。",
    });
  }
}

/**
 * GET /api/contacts — Danh sách liên hệ (admin only)
 * Query: ?status=new|in_progress|resolved|closed
 */
export async function getAllContacts(req, res) {
  try {
    const { status } = req.query;
    const where = {};
    if (status && VALID_STATUSES.includes(status)) {
      where.status = status;
    }
    const contacts = await Contact.findAll({
      where,
      order: [["createdAt", "DESC"]],
    });
    res.json({ contacts, statusOptions: CONTACT_STATUS });
  } catch (err) {
    console.error("❌ getAllContacts error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * GET /api/contacts/:id — Chi tiết một liên hệ (admin only)
 */
export async function getContactById(req, res) {
  try {
    const { id } = req.params;
    const contact = await Contact.findByPk(id);
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }
    res.json({ contact, statusOptions: CONTACT_STATUS });
  } catch (err) {
    console.error("❌ getContactById error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

/**
 * PATCH /api/contacts/:id — Cập nhật trạng thái (admin only)
 * Body: { status: "new" | "in_progress" | "resolved" | "closed" }
 */
export async function updateContactStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: "Invalid status",
        allowed: VALID_STATUSES,
        statusOptions: CONTACT_STATUS,
      });
    }
    const contact = await Contact.findByPk(id);
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }
    await contact.update({ status });
    res.json({ contact, message: "Trạng thái đã cập nhật." });
  } catch (err) {
    console.error("❌ updateContactStatus error:", err);
    res.status(500).json({ error: "Server error" });
  }
}
