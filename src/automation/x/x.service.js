// src/automation/x/x.service.js
import fetch from "node-fetch";
import * as cheerio from "cheerio";

import XItemPkg from "../../models/XItem.js";
const XItem = XItemPkg.default || XItemPkg;

const DEFAULT_IMAGE = process.env.AUTOMATION_DEFAULT_IMAGE_ID || "";

// rotate more mirrors (these tend to work more often)
const NITTER_MIRRORS = [
  "https://nitter.kavin.rocks",
  "https://nitter.catsarch.com",
  "https://nitter.privacydev.net",
  "https://nitter.lunar.icu",
  "https://nitter.net"
];

export async function fetchTweetsForHandle(handle, sinceDays = 4) {
  handle = String(handle || "").replace(/^@/, "").trim();
  if (!handle) throw new Error("invalid handle");

  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  let html = null;
  let used = null;

  for (const base of NITTER_MIRRORS) {
    try {
      const url = `${base}/${handle}`;
      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) continue;
      html = await res.text();
      used = base;
      break;
    } catch {
      // try next mirror
    }
  }
  if (!html) throw new Error("All Nitter mirrors failed");

  const $ = cheerio.load(html);
  const found = [];

  $(".timeline-item").each((_, el) => {
    const href = $(el).find(".tweet-link").attr("href") || "";
    const id = href.split("/status/")[1]?.split("?")[0];
    const text = $(el).find(".tweet-content").text().trim();
    const timeStr = $(el).find("time").attr("datetime");
    const tweetedAt = new Date(timeStr || Date.now());
    if (!id || tweetedAt.getTime() < cutoff) return;

    const mediaUrls = [];
    $(el).find(".attachments img").each((__, img) => {
      const src = $(img).attr("src");
      if (src) mediaUrls.push(src.startsWith("http") ? src : (used + src));
    });

    found.push({ id, text, tweetedAt, media: mediaUrls });
  });

  let inserted = 0;
  for (const t of found) {
    const exists = await XItem.findOne({ xId: t.id });
    if (exists) continue;

    await XItem.create({
  handle,
  xId: t.id,
  text: t.text,
  tweetedAt: t.tweetedAt,
  media: t.media,
  image: t.media?.[0] || (process.env.AUTOMATION_DEFAULT_IMAGE_ID || ""),
  status: "new",
});

    inserted++;
  }
  return inserted;
}
