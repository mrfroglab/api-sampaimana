const nodemailer = require('nodemailer');
const env = require('../config/env');

let transport = null;
if (env.SMTP_URL && !env.isTest) {
  transport = nodemailer.createTransport(env.SMTP_URL);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Sends an email if SMTP is configured; otherwise it is a no-op (in-app
 * notifications still work). Never throws: email is best effort.
 */
const sendMail = async ({ to, subject, text, link, linkLabel = 'Lihat perkembangan', footer }) => {
  if (!transport) return false;
  const url = link ? new URL(link, env.PUBLIC_URL).toString() : null;
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;color:#1c1917">
    <p style="font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#78716c">Sampai Mana</p>
    <h1 style="font-size:22px;line-height:1.3;margin:0 0 12px">${escapeHtml(subject)}</h1>
    <p style="font-size:16px;line-height:1.6">${escapeHtml(text)}</p>
    ${url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#1c1917;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-family:system-ui,sans-serif">${escapeHtml(linkLabel)}</a></p>` : ''}
    <p style="font:12px/1.5 system-ui,sans-serif;color:#78716c;margin-top:32px">${escapeHtml(footer || 'Anda menerima email ini karena mengikuti kasus di Sampai Mana. Matikan notifikasi email di halaman akun Anda.')}</p>
  </div>`;
  try {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text: url ? `${text}\n\n${url}` : text, html });
    return true;
  } catch (err) {
    console.error('Gagal mengirim email:', err.message);
    return false;
  }
};

module.exports = { sendMail };
