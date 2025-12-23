// backend/src/routes/rss.topnews.js

const express = require("express");
const router = express.Router();
const Article = require("../models/Article");

// ───────────────────────────────────────────────────────────────────────────────
// Site base URL (links in RSS items)
// ───────────────────────────────────────────────────────────────────────────────

const FRONTEND_BASE_URL =
  (process.env.FRONTEND_BASE_URL ||
    process.env.SITE_URL ||
    "https://timelyvoice.com").replace(/\/$/, "");
const SITE_URL = FRONTEND_BASE_URL;

// ───────────────────────────────────────────────────────────────────────────────
// Cloudinary default image + URL builder (for RSS fallback)
// ───────────────────────────────────────────────────────────────────────────────

const DEFAULT_PID =
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  "news-images/defaults/fallback-hero";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || null;

function buildCloudinaryUrl(publicId, transform = "") {
  if (!CLOUD_NAME || !publicId) return "";
  const encodedPid = encodeURIComponent(publicId);
  const base = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/`;
  return transform ? `${base}${transform}/${encodedPid}` : `${base}${encodedPid}`;
}

// OG-style default hero used when article has no real image
const FALLBACK_OG_URL = buildCloudinaryUrl(
  DEFAULT_PID,
  "c_fill,g_auto,h_630,w_1200,f_jpg"
);

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

// strip placeholders like "leave it empty" and wrapping quotes
function sanitizeMarker(val) {
  if (!val) return "";
  let s = String(val).trim();
  if (!s) return "";

  // remove leading/trailing quotes
  s = s.replace(/^['"]+|['"]+$/g, "").trim();
  if (!s) return "";

  const lower = s.toLowerCase();
  if (
    /^leave\s+(it|this)?\s*empty$/.test(lower) ||
    lower === "leave empty" ||
    lower === "none" ||
    lower === "n/a"
  ) {
    return "";
  }

  return s;
}

function esc(s = "") {
  return String(s).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return c;
    }
  });
}

function articleUrlFromSlug(slug) {
  if (!slug) return SITE_URL;
  return `${SITE_URL}/article/${encodeURIComponent(slug)}`;
}

// ✅ Make MIME detection work for BOTH Cloudinary (no extension) + normal URLs
function guessMimeFromUrl(url = "") {
  const raw = String(url || "").toLowerCase();
  const u = raw.split("?")[0].split("#")[0];

  // ✅ Cloudinary transform hints (these URLs often don't end with .jpg/.png)
  if (u.includes("f_jpg") || u.includes("f_jpeg")) return "image/jpeg";
  if (u.includes("f_png")) return "image/png";
  if (u.includes("f_webp")) return "image/webp";

  // ✅ Cloudinary video URLs often work as mp4 even if format isn't obvious
  if (u.includes("/video/upload/")) return "video/mp4";

  // ✅ Google Drive "direct" link (no extension)
  if (u.includes("drive.google.com/uc?export=download")) return "video/mp4";

  // Video by extension
  if (u.endsWith(".mp4")) return "video/mp4";
  if (u.endsWith(".webm")) return "video/webm";
  if (u.endsWith(".mov")) return "video/quicktime";
  if (u.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";

  // Image by extension
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".gif")) return "image/gif";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";

  return "application/octet-stream";
}

// Try to convert Google Drive share links to a direct-ish file URL
function getDriveFileId(url = "") {
  const s = String(url || "");
  if (!s) return "";
  // /file/d/<id>/
  const m1 = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return m1[1];
  // ?id=<id>
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return m2[1];
  return "";
}

function driveDirectUrl(url = "") {
  const id = getDriveFileId(url);
  if (!id) return "";
  return `https://drive.google.com/uc?export=download&id=${id}`;
}

// Normalize any possible "image" value coming from Mongo
function normalizeImageField(raw) {
  if (!raw) return "";

  // Handle { url, secure_url } objects (e.g. cover)
  if (typeof raw === "object") {
    if (raw.secure_url || raw.url) {
      raw = raw.secure_url || raw.url;
    } else {
      return "";
    }
  }

  const cleaned = sanitizeMarker(raw);
  if (!cleaned) return "";

  const s = cleaned;

  // ❌ Google Drive links render as HTML, not direct images → skip for RSS
  if (/drive\.google\.com/i.test(s)) {
    return "";
  }

  // Already a full URL
  if (/^https?:\/\//i.test(s)) return s;

  // Otherwise, if we have Cloudinary, assume it's a publicId
  if (CLOUD_NAME) {
    return buildCloudinaryUrl(s, "c_fill,g_auto,h_630,w_1200,f_jpg");
  }

  return "";
}

// Normalize video URL coming from Mongo
function normalizeVideoField(raw) {
  if (!raw) return "";
  const cleaned = sanitizeMarker(raw);
  if (!cleaned) return "";

  const s = cleaned;

  // If it's a Drive share link, try converting to a direct file URL
  if (/drive\.google\.com/i.test(s)) {
    const direct = driveDirectUrl(s);
    return direct || "";
  }

  // Must be a URL for RSS safety
  if (/^https?:\/\//i.test(s)) return s;

  return "";
}

// Decide which image to use for RSS:
// 1) ogImage
// 2) imageUrl
// 3) cover.url / cover.secure_url
// 4) imagePublicId
// 5) fallback OG hero
function pickBestImageForRss(article) {
  const coverObj = article.cover || {};
  const coverUrl = normalizeImageField(coverObj.secure_url || coverObj.url);

  const candidates = [
    normalizeImageField(article.ogImage),
    normalizeImageField(article.imageUrl),
    coverUrl,
    normalizeImageField(article.imagePublicId),
  ].filter(Boolean);

  return candidates[0] || FALLBACK_OG_URL || "";
}

// ✅ Build a Cloudinary poster thumbnail from a Cloudinary video URL
// Example input:
// https://res.cloudinary.com/<cloud>/video/upload/v123/folder/file.mp4
// Output poster:
// https://res.cloudinary.com/<cloud>/video/upload/so_1/folder/file.jpg
function buildVideoPosterFromCloudinaryVideo(videoUrl = "") {
  const v = String(videoUrl || "");
  if (!v) return "";
  if (!v.includes("res.cloudinary.com") || !v.includes("/video/upload/")) return "";

  // Insert "so_1" transformation right after /video/upload/
  // and convert extension to .jpg for poster frame
  const parts = v.split("/video/upload/");
  if (parts.length !== 2) return "";

  const base = parts[0] + "/video/upload/";
  let rest = parts[1];

  // remove query/hash
  rest = rest.split("?")[0].split("#")[0];

  // if already ends with .mp4/.webm/.mov etc, replace extension with .jpg
  rest = rest.replace(/\.(mp4|webm|mov|m3u8)$/i, ".jpg");

  return `${base}so_1/${rest}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Shared handler for both /top-news and /top-news.xml
// ───────────────────────────────────────────────────────────────────────────────

async function handleTopNewsRss(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const now = new Date();

    const rows = await Article.find({
      status: "published",
      $or: [
        { publishedAt: { $lte: now } },
        { publishAt: { $lte: now } },
        {
          $and: [
            { publishedAt: { $exists: false } },
            { publishAt: { $exists: false } },
          ],
        },
      ],
    })
      .select(
        "title slug summary publishedAt publishAt updatedAt createdAt imageUrl ogImage cover imagePublicId videoUrl"
      )
      .sort({
        publishedAt: -1,
        publishAt: -1,
        createdAt: -1,
        _id: -1,
      })
      .limit(limit)
      .lean();

    const nowStr = new Date().toUTCString();

    // ✅ Add MRSS + content namespace (for content:encoded)
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:media="http://search.yahoo.com/mrss/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>The Timely Voice — Top News</title>
  <link>${esc(SITE_URL + "/top-news")}</link>
  <description>Newest headlines from The Timely Voice</description>
  <language>en</language>
  <lastBuildDate>${esc(nowStr)}</lastBuildDate>
`;

    for (const a of rows) {
      const link = articleUrlFromSlug(a.slug);
      const pub =
        a.publishedAt || a.publishAt || a.updatedAt || a.createdAt || new Date();
      const pubDate = new Date(pub).toUTCString();
      const desc = a.summary || "";

      // ✅ Video-first
      const video = normalizeVideoField(a.videoUrl);
      const hasVideo = !!video;

      // ✅ Base image (used as fallback)
      const img = pickBestImageForRss(a);

      // ✅ If video is Cloudinary, generate a poster so RSS cards look like video
      const posterFromVideo = hasVideo ? buildVideoPosterFromCloudinaryVideo(video) : "";
      const thumb = posterFromVideo || img; // prefer video poster; else normal image
      const hasThumb = !!thumb;

      xml += `  <item>
    <title>${esc(a.title || "")}</title>
    <link>${esc(link)}</link>
    <guid isPermaLink="true">${esc(link)}</guid>
    <pubDate>${esc(pubDate)}</pubDate>
    <description><![CDATA[${desc}]]></description>
`;

      if (hasVideo) {
        const mime = guessMimeFromUrl(video);

        // ✅ Provide full HTML content (some readers show video when opened)
        // Note: RSS readers may still show a thumbnail in the list; that's normal.
        xml += `    <content:encoded><![CDATA[
      <p>${desc}</p>
      <video controls preload="metadata" width="100%">
        <source src="${video}" type="${mime}" />
      </video>
    ]]></content:encoded>
`;

        // MRSS video
        xml += `    <media:content url="${esc(video)}" type="${esc(
          mime
        )}" medium="video" />
`;

        // Thumbnail for readers/cards
        if (hasThumb) {
          xml += `    <media:thumbnail url="${esc(thumb)}" />
`;
        }

        // Classic RSS enclosure for compatibility
        xml += `    <enclosure url="${esc(video)}" type="${esc(mime)}" />
`;
      } else if (hasThumb) {
        const mime = guessMimeFromUrl(thumb);
        xml += `    <enclosure url="${esc(thumb)}" type="${esc(mime)}" />
`;
      }

      xml += `  </item>
`;
    }

    xml += `</channel>
</rss>`;

    res.set("Content-Type", "application/rss+xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=60");
    res.status(200).send(xml);
  } catch (err) {
    console.error("[RSS] /rss/top-news error:", err);
    next(err);
  }
}

// Support both /rss/top-news and /rss/top-news.xml
router.get("/top-news", handleTopNewsRss);
router.get("/top-news.xml", handleTopNewsRss);

module.exports = router;
