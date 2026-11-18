import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const fromEmail = process.env.MAIL_USER;
const fromName = process.env.MAIL_FROM_NAME || "エアログサポート";
const useResend = !!process.env.RESEND_API_KEY;


export const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST || "smtp.gmail.com",
  port: parseInt(process.env.MAIL_PORT || "587", 10),
  secure: process.env.MAIL_SECURE === "true",
  auth: {
    user: fromEmail,
    pass: process.env.MAIL_PASS,
  },
  connectionTimeout: 10000,
});

// Chỉ verify SMTP khi dùng Nodemailer và không dùng Resend (tránh timeout trên Render)
if (!useResend && fromEmail && process.env.MAIL_PASS) {
  transporter
    .verify()
    .then(() => console.log("✅ Mail transporter (SMTP) ready"))
    .catch((err) => console.error("❌ Mail transporter error:", err.message));
} else if (useResend) {
  console.log("✅ Mail: using Resend API (HTTPS) — phù hợp Render/cloud");
} else {
  console.warn("⚠️ Chưa cấu hình mail: đặt RESEND_API_KEY (khuyến nghị trên Render) hoặc MAIL_USER + MAIL_PASS");
}

/**
 * Gửi email qua Resend API (HTTPS, hoạt động trên Render).
 */
async function sendViaResend(to, subject, text, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || `"${fromName}" <noreply@aerolog.jp>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: text || undefined,
      html: html || undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || `Resend API ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return { messageId: data.id };
}

/**
 * Gửi email (plain text hoặc HTML).
 * Ưu tiên Resend nếu có RESEND_API_KEY (dùng HTTPS, không bị chặn trên Render).
 */
export async function sendMail(to, subject, text, html = undefined) {
  if (useResend) {
    const info = await sendViaResend(to, subject, text, html);
    console.log("📧 Mail sent (Resend):", to, "| id:", info.messageId);
    return info;
  }
  if (!fromEmail || !process.env.MAIL_PASS) {
    const err = new Error("Mail chưa cấu hình: đặt RESEND_API_KEY hoặc MAIL_USER + MAIL_PASS");
    console.error("❌", err.message);
    throw err;
  }
  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
  };
  if (html) mailOptions.html = html;
  const info = await transporter.sendMail(mailOptions);
  console.log("📧 Mail sent (SMTP):", to, "| messageId:", info.messageId);
  return info;
}
