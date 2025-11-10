// backend/scripts/telegram-test.js
require("dotenv").config();
const { postArticle } = require("../src/services/telegram.service");

(async () => {
  const ok = await postArticle({
    title: "Timely Voice · Telegram test",
    summary: "If you see this in the channel, your bot wiring works perfectly.",
    url: "https://timelyvoice.com",
    imageUrl: null, // or add a public HTTPS image link to test sendPhoto
  });
  console.log("Posted?", ok);
  process.exit(ok ? 0 : 1);
})();

