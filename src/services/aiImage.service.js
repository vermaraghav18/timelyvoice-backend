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

  // 🔹 1) Build a strong prompt for a news-style hero image
  const tagList = Array.isArray(tags) ? tags.join(", ") : "";
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

  // 🔹 2) Call OpenRouter / Gemini Image
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://timelyvoice.com", // optional attribution
      "X-Title": "The Timely Voice - AI Image",
    },
    body: JSON.stringify({
      model: AI_IMAGE_MODEL,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
      stream: false,
      extra_headers: { "x-openrouter-ignore-ratelimit": "false" },
      extra_body: {
        image_config: {
          aspect_ratio: "16:9", // Gemini-supported aspect ratio :contentReference[oaicite:1]{index=1}
        },
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

  // imageUrl is a base64 data URL like "data:image/png;base64,AAA..."
  // Cloudinary accepts data URLs directly.
  const publicIdBase = `ai-${slug || article._id}`;
  const upload = await cloudinary.uploader.upload(imageUrl, {
    folder: process.env.CLOUDINARY_FOLDER
      ? `${process.env.CLOUDINARY_FOLDER}/ai`
      : "news-images/ai",
    public_id: publicIdBase,
    overwrite: true,
    resource_type: "image",
  });

  const variants = buildImageVariants(upload.public_id);

  // 🔹 3) Save on article (overwrite any existing image)
  article.imagePublicId = upload.public_id;
  article.imageUrl = variants.hero || upload.secure_url;
  article.ogImage = variants.og || variants.hero || upload.secure_url;
  article.thumbImage = variants.thumb || variants.hero || upload.secure_url;
  article.imageAlt =
    article.imageAlt ||
    `AI-generated illustration for article: ${title}`.slice(0, 160);

  await article.save();

  return {
    articleId: article._id,
    imagePublicId: article.imagePublicId,
    imageUrl: article.imageUrl,
    ogImage: article.ogImage,
    thumbImage: article.thumbImage,
  };
}

module.exports = {
  generateAiHeroForArticle,
};
