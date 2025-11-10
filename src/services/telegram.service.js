// backend/src/services/telegram.service.js
const axios = require("axios");

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const api = axios.create({
  timeout: 10000, // 10s
  validateStatus: s => s >= 200 && s < 500, // let us inspect 4xx bodies
});

const escapeHtml = (s = "") =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const trunc = (s = "", n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Posts an article to Telegram. Returns true on success, false on handled failure.
 */
async function postArticle({ title, summary, url, imageUrl }) {
  if (!TG_TOKEN || !CHAT_ID) {
    console.warn("[telegram] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return false;
  }

  const API = `https://api.telegram.org/bot${TG_TOKEN}`;

  try {
    if (imageUrl) {
      const caption =
        `<b>${escapeHtml(title || "")}</b>\n` +
        (summary ? `${escapeHtml(trunc(summary, 700))}\n\n` : "\n") +
        `${url || ""}`;

      const r = await api.post(`${API}/sendPhoto`, {
        chat_id: CHAT_ID,
        photo: imageUrl,       // must be a public HTTPS URL
        caption,
        parse_mode: "HTML",
      });
      if (!r.data?.ok) throw new Error(r.data?.description || "sendPhoto failed");
      return true;
    }

    const text =
      `<b>${escapeHtml(title || "")}</b>\n` +
      (summary ? `${escapeHtml(trunc(summary, 3500))}\n\n` : "\n") +
      `${url || ""}`;

    const r = await api.post(`${API}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
    if (!r.data?.ok) throw new Error(r.data?.description || "sendMessage failed");
    return true;
  } catch (e) {
    // Common causes: chat not found (bot not admin), wrong chat id, bad token
    console.warn("[telegram] post failed:", e.message);
    return false;
  }
}

module.exports = { postArticle };
