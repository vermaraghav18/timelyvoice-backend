// STEP 1: Image strategy orchestrator (Cloudinary-first)
// File: backend/src/services/imageStrategy.js
// Purpose: If an incoming article lacks imageUrl/imagePublicId, attach one automatically
// using the chosen strategy (default: cloudinary). Fallback now uses a default Cloudinary image.

const assert = require('assert');
const cloudinary = require('cloudinary').v2; // ← added

// You already have this in your repo. We reuse it.
// Expected to return { publicId, url } or null
const { chooseHeroImage } = require('./imagePicker');

/**
 * Normalize: ensure we have fields to work with and keep alt text safe.
 */
function normalizeArticleInput(a = {}) {
  return {
    title: a.title || '',
    summary: a.summary || a.excerpt || '',
    category: a.category || a.section || '',
    tags: Array.isArray(a.tags)
      ? a.tags
      : (typeof a.tags === 'string'
          ? a.tags.split(',').map(s => s.trim()).filter(Boolean)
          : []),
    slug: a.slug || '',
    imageAlt: a.imageAlt || a.title || '',
  };
}

/**
 * Strategy: Cloudinary library (uses your existing picker)
 * Returns {publicId, url} or null
 */
async function attachFromCloudinary(meta) {
  try {
    const picked = await chooseHeroImage({
      title: meta.title,
      summary: meta.summary,
      category: meta.category,
      tags: meta.tags,
      slug: meta.slug,
    });
    if (!picked) return null;
    if (!picked.publicId && !picked.public_id && !picked.url) return null;
    const publicId = picked.publicId || picked.public_id || null;
    const url = picked.url || picked.secure_url || null;
    return { publicId, url };
  } catch (err) {
    console.error('[imageStrategy] Cloudinary pick failed:', err?.message || err);
    return null;
  }
}

/**
 * Fallback: use a single default Cloudinary image (no external stock).
 * Set .env → CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID="news-images/defaults/fallback-hero"
 * Returns { publicId, url } or null
 */
async function attachFromStock(/* meta */) {
  try {
    const publicId = process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID;
    if (!publicId) return null;
    const url = cloudinary.url(publicId, { secure: true });
    return { publicId, url };
  } catch (err) {
    console.error('[imageStrategy] default fallback failed:', err?.message || err);
    return null;
  }
}

/**
 * AI is disabled for now (can be implemented later if needed)
 */
async function attachFromAI(/* meta */) { return null; }

/**
 * Orchestrator — tries the selected strategy and (optionally) fallbacks.
 *
 * @param {Object} article - the mutable article object to update in-place
 * @param {Object} opts
 * @param {('cloudinary'|'stock'|'ai')} [opts.imageStrategy='cloudinary']
 * @param {Array<'cloudinary'|'stock'|'ai'>} [opts.fallbacks=['stock']]
 * @returns {Promise<'attached'|'skipped'|'failed'>}
 */
async function decideAndAttach(article, opts = {}) {
  assert(article && typeof article === 'object', 'article object required');

  // Default to cloudinary → default-image fallback only (no AI)
  const {
    imageStrategy = 'cloudinary',
    fallbacks = ['stock'],
  } = opts;

  // If already present, skip
  // Only skip if a real image URL or a real publicId already exists
  if (article.imagePublicId) return 'skipped';
  if (article.imageUrl) {
    try {
      const { hostname } = new URL(article.imageUrl);
      if (hostname && !hostname.endsWith('.example') && !hostname.includes('cdn.example')) {
        return 'skipped';
      }
    } catch {
      // invalid URL → treat as absent
    }
  }

  const meta = normalizeArticleInput(article);

  const tryOne = async (strategy) => {
    switch (strategy) {
      case 'cloudinary': return attachFromCloudinary(meta);
      case 'stock':      return attachFromStock(meta); // our Cloudinary default
      case 'ai':         return attachFromAI(meta);     // currently disabled (returns null)
      default:           return null;
    }
  };

  // primary
  let picked = await tryOne(imageStrategy);

  // fallbacks if nothing found
  if (!picked) {
    for (const s of fallbacks) {
      picked = await tryOne(s);
      if (picked) break;
    }
  }

  if (!picked) return 'failed';

  // Apply to the incoming article
  if (picked.publicId) article.imagePublicId = picked.publicId;
  if (!article.imageAlt) article.imageAlt = meta.imageAlt;

  // optionally set a full URL now
  if (picked.url && !article.imageUrl) {
    article.imageUrl = picked.url;
  }

  return 'attached';
}

module.exports = {
  decideAndAttach,
};
