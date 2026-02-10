// backend/src/services/aiImage.service.js
const { v2: cloudinary } = require("cloudinary");
const Article = require("../models/Article");
const { buildImageVariants } = require("./imageVariants");

// lazy fetch polyfill
const fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_IMAGE_MODEL =
  process.env.AI_IMAGE_MODEL || "google/gemini-2.5-flash-image-preview";

if (!cloudinary.config().cloud_name) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// ------------------------------
// Tag normalization (must match picker)
// ------------------------------
function stem(t) {
  if (!t) return "";
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("s") && t.length > 3) return t.slice(0, -1);
  return t;
}
function normalizeTag(raw = "") {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const noHash = s.replace(/^#+/g, "");
  const clean = noHash.replace(/[^a-z0-9_-]/g, "");
  return clean;
}
function normStemTag(raw = "") {
  return stem(normalizeTag(raw));
}
function dedupe(arr) {
  return Array.from(new Set(arr));
}
function normalizeTagsInput(tags) {
  if (!tags) return [];
  if (typeof tags === "string") {
    return tags
      .split(/[,|]/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .map(normStemTag)
      .filter(Boolean);
  }
  if (Array.isArray(tags)) {
    return tags
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object") return x.value || x.label || x.name || "";
        return "";
      })
      .map(normStemTag)
      .filter(Boolean);
  }
  return [];
}

/**
 * Generate a hero-style news image for an article
 * and upload it to Cloudinary.
 */
async function generateAiHeroForArticle(articleId) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const article = await Article.findById(articleId);
  if (!article) throw new Error("Article not found");

  const { title, summary, category, tags, slug } = article;

  // normalize tags (for Cloudinary + future picker)
  const normalizedTags = dedupe(normalizeTagsInput(tags));

  // Build prompt
  const tagList = normalizedTags.join(", ");
  const categoryText = category?.name || category || "News";

  const prompt = `
You are generating a SINGLE hero photograph for a serious online news article.

Article title: "${title}"
Summary: "${summary || ""}"
Category: ${categoryText}
Tags: ${tagList}

Requirements:
- Style: realistic news photograph, editorial style, no text, no watermarks, no logos.
- Composition: clean, uncluttered, suitable as a website hero image.
- Aspect ratio: 16:9 landscape, centered subject.
- Avoid: faces that look like specific real politicians or celebrities unless clearly implied.
- Color: natural, not over-saturated.
Return just the image that best represents this story.
  `.trim();

  // Call OpenRouter
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://timelyvoice.com",
      "X-Title": "The Timely Voice - AI Image",
    },
    body: JSON.stringify({
      model: AI_IMAGE_MODEL,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
      stream: false,
      extra_headers: { "x-openrouter-ignore-ratelimit": "false" },
      extra_body: {
        image_config: { aspect_ratio: "16:9" },
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `OpenRouter image error: ${resp.status} ${resp.statusText} - ${errText}`
    );
  }

  const data = await resp.json();
  const msg = data.choices?.[0]?.message;

  const imageUrl =
    msg?.images?.[0]?.image_url?.url ||
    msg?.images?.[0]?.imageUrl?.url ||
    null;

  if (!imageUrl) {
    throw new Error("No image returned from AI model");
  }

  // Upload to Cloudinary WITH TAGS + CONTEXT (important!)
  const publicIdBase = `ai-${slug || article._id}`;
  const upload = await cloudinary.uploader.upload(imageUrl, {
    folder: process.env.CLOUDINARY_FOLDER
      ? `${process.env.CLOUDINARY_FOLDER}/ai`
      : "news-images/ai",
    public_id: publicIdBase,
    overwrite: true,
    resource_type: "image",

    // ✅ THIS is the missing piece:
    tags: normalizedTags.length ? normalizedTags : undefined,

    // Optional: add context too (secondary signals)
    context: `title=${encodeURIComponent(title || "")}|slug=${encodeURIComponent(
  slug || String(article._id)
)}|category=${encodeURIComponent(String(categoryText || ""))}|tags=${encodeURIComponent(
  tagList || ""
)}`,

  });

  const variants = buildImageVariants(upload.public_id);

  // Save on article (overwrite any existing image)
  article.imagePublicId = upload.public_id;
  article.imageUrl = variants.hero || upload.secure_url;
  article.ogImage = variants.og || variants.hero || upload.secure_url;
  article.thumbImage = variants.thumb || variants.hero || upload.secure_url;
  article.imageAlt =
    article.imageAlt ||
    `AI-generated illustration for article: ${title}`.slice(0, 160);

  // Useful debugging flags (optional)
  article.autoImagePicked = true;
  article.autoImagePickedAt = new Date();
  article.autoImageDebug = {
    mode: "ai-generated-upload",
    cloudinaryPublicId: upload.public_id,
    tagsApplied: normalizedTags,
  };

  await article.save();

  return {
    articleId: article._id,
    imagePublicId: article.imagePublicId,
    imageUrl: article.imageUrl,
    ogImage: article.ogImage,
    thumbImage: article.thumbImage,
    tagsApplied: normalizedTags,
  };
}

module.exports = {
  generateAiHeroForArticle,
};
