const fetch = global.fetch || require("node-fetch");
const cheerio = require("cheerio");

async function extractSourceImage(item) {
  // 1️⃣ RSS media:content / media:thumbnail
  const media =
    item?.media?.content ||
    item?.["media:content"] ||
    item?.media?.thumbnail ||
    item?.["media:thumbnail"];

  if (typeof media === "string" && media.startsWith("http")) {
    return { url: media, from: "rss_media" };
  }

  if (Array.isArray(media) && media.length) {
    const u = media[0]?.url || media[0]?.$?.url;
    if (u && u.startsWith("http")) {
      return { url: u, from: "rss_media" };
    }
  }

  // 2️⃣ RSS enclosure
  if (item?.enclosure?.url && item.enclosure.url.startsWith("http")) {
    return { url: item.enclosure.url, from: "rss_enclosure" };
  }

  // 3️⃣ OG image fallback
  if (!item?.link) return { url: "", from: "unknown" };

  try {
    const res = await fetch(item.link, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
      timeout: 8000,
    });

    const html = await res.text();
    const $ = cheerio.load(html);

    const og =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[property="og:image:url"]').attr("content") ||
      $('meta[name="og:image"]').attr("content");

    if (og && og.startsWith("http")) {
      return { url: og, from: "og_image" };
    }
  } catch {
    // silently ignore
  }

  return { url: "", from: "unknown" };
}

module.exports = { extractSourceImage };
