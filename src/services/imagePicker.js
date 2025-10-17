// backend/src/services/imagePicker.js
const cloudinary = require('cloudinary').v2;

const FOLDER = process.env.AUTOMATION_IMAGE_FOLDER || 'news-images';
const DEFAULT_ID = process.env.AUTOMATION_DEFAULT_IMAGE_ID || `${FOLDER}/default-hero`;

// in-memory cache
let _cache = { ts: 0, items: [] };
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

function tokenize(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function scoreMatch(tokens, nameTokens) {
  // basic overlap score
  const set = new Set(tokens);
  let score = 0;
  for (const t of nameTokens) if (set.has(t)) score += 1;
  return score;
}

async function listFolder(force = false) {
  const now = Date.now();
  if (!force && _cache.items.length && now - _cache.ts < CACHE_MS) return _cache.items;

  let nextCursor = undefined;
  const out = [];
  do {
    const resp = await cloudinary.api.resources({
      type: 'upload',
      prefix: `${FOLDER}/`,      // list only inside folder
      max_results: 100,
      next_cursor: nextCursor,
    });
    for (const r of resp.resources || []) {
      // r.public_id e.g. "news-images/cricket-bat-stadium"
      const filename = r.public_id.split('/').pop(); // cricket-bat-stadium
      out.push({
        publicId: r.public_id,
        filename,
        tokens: tokenize(filename),
        format: r.format,
        width: r.width,
        height: r.height,
      });
    }
    nextCursor = resp.next_cursor;
  } while (nextCursor);

  _cache = { ts: now, items: out };
  return out;
}

/**
 * Choose a hero image by filename keywords.
 * If nothing matches, return the DEFAULT_ID.
 *
 * @param {Object} ctx { title, summary, category, tags[] }
 * @returns {Object} { publicId, url }
 */
async function chooseHeroImage(ctx = {}) {
  const items = await listFolder(false);

  const tokens = new Set([
    ...tokenize(ctx.title || ''),
    ...tokenize(ctx.summary || ''),
    ...tokenize(ctx.category || ''),
    ...((ctx.tags || []).flatMap(tokenize)),
  ]);

  // Prefer some generic category synonyms
  const enrich = [];
  const cat = String(ctx.category || '').toLowerCase();
  if (cat.includes('sport')) enrich.push('sports', 'cricket', 'football');
  if (cat.includes('business') || cat.includes('market')) enrich.push('stocks', 'market', 'business');
  if (cat.includes('tech')) enrich.push('technology', 'ai');
  if (cat.includes('politic')) enrich.push('politics', 'parliament');
  for (const t of enrich) tokens.add(t);

  const tokenArr = Array.from(tokens);
  let best = null;
  let bestScore = -1;

  for (const it of items) {
    const s = scoreMatch(it.tokens, tokenArr);
    if (s > bestScore) {
      best = it;
      bestScore = s;
    }
  }

  const publicId = (best && bestScore > 0) ? best.publicId : DEFAULT_ID;

  // Build a nice hero URL (1200x630) – jpg for OG
  const url = cloudinary.url(publicId, {
    width: 1200, height: 630, crop: 'fill', format: 'jpg'
  });

  return { publicId, url };
}

module.exports = {
  listFolder,
  chooseHeroImage,
};
