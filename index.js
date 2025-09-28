require('dotenv').config();
const express = require('express');
const cors = require('cors');
const analyticsBotFilter = require('./middleware/analyticsBotFilter'); // <-- add this
const analyticsRouter = require('./routes/analytics');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const geoMiddleware = require('./middleware/geo');

const app = express();
// Trust reverse proxy headers (Render etc.)
app.set('trust proxy', 1);

// JSON parser (needed for POST /analytics/collect)
app.use(express.json({ limit: '200kb' }));

// CORS allowlist
// CORS allowlist
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  allowedOrigins.push(
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://news-site-frontend-sigma.vercel.app'
  );
}

// Shared CORS options (used for middleware and preflight)
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true); // allow curl/postman
    const ok = allowedOrigins.includes(origin);
    callback(ok ? null : new Error('Not allowed by CORS'), ok);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Geo-Preview-Country', // <-- allow the custom header your frontend sends
  ],
  credentials: true,          // <-- required when frontend requests include credentials
  maxAge: 86400,
};

app.use(cors(corsOptions));
// Ensure preflight OPTIONS succeeds for all routes
app.options('*', cors(corsOptions));


// Bot/Admin flags for analytics (used to exclude)
app.use(analyticsBotFilter());

// GEO middleware (enriches req.geo for feeds/sitemaps/SSR)
app.use(geoMiddleware());


// Country-aware caching: make caches keep separate copies per geo + auth
app.use((req, res, next) => {
  res.setHeader(
    'Vary',
    'CF-IPCountry, X-Vercel-IP-Country, X-Vercel-IP-Country-Region, X-Vercel-IP-City, X-Fastly-Country-Code, Authorization'
  );
  next();
});

// If we couldn't detect GEO, mark response (handy for debugging/UI hints)
app.use((req, res, next) => {
  if (!req.geo?.country) res.setHeader('X-Geo-Fallback', 'global-only');
  next();
});

// Debug logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---- Analytics endpoints (health + collector stub) ----
app.use('/analytics', analyticsRouter);


const {
  ADMIN_PASSWORD, JWT_SECRET, MONGO_URI,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_FOLDER = 'news-site',
  PUBLICATION_NAME = 'My News'
} = process.env;

// Admin-only guard for X-Geo-Preview-Country
app.use((req, _res, next) => {
  const preview = req.headers['x-geo-preview-country'];
  if (!preview) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  let isAdmin = false;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role === 'admin') isAdmin = true;
    } catch (_) { /* ignore */ }
  }

  if (!isAdmin) {
    delete req.headers['x-geo-preview-country'];
    const fallback =
      req.headers['cf-ipcountry'] ||
      req.headers['x-vercel-ip-country'] ||
      req.headers['x-fastly-country-code'] || null;

    if (!req.geo) req.geo = {};
    req.geo.country = fallback ? String(fallback).toUpperCase().slice(0, 2) : null;
    req.geo.source = fallback ? 'header' : 'unknown';
  }
  next();
});

// TEMP: Inspect req.geo (for Step 2/3 testing) — placed AFTER the guard
app.get('/api/dev/echo-geo', (req, res) => {
  res.json({ geo: req.geo });
});

// Cloudinary config
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

// DB
mongoose.connect(MONGO_URI, { dbName: 'newsdb' })
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => { console.error('❌ MongoDB connection error:', err.message); process.exit(1); });

// ==== Helpers ====
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function uniqueSlugForTitle(title) {
  const base = slugify(title) || 'article';
  let s = base;
  let i = 2;
  // eslint-disable-next-line no-constant-condition
  while (await Article.exists({ slug: s })) {
    s = `${base}-${i++}`;
  }
  return s;
}

// Schema
const articleSchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug:  { type: String, required: true, unique: true, index: true },
  summary: { type: String, required: true },
  author: { type: String, required: true },
  body: { type: String, required: true },
  category: { type: String, default: 'General' },
  imageUrl: { type: String },
  imagePublicId: { type: String },

  // NEW (GEO): targeting fields
  // Tokens allowed (examples):
  //   country:IN
  //   state:IN:DL
  //   city:IN:Delhi
  geoMode: {
    type: String,
    enum: ['global', 'include', 'exclude'],
    default: 'global'
  },
  geoAreas: {
    type: [String],
    default: []
  },

  // NEW: drafts & scheduling
  status: { type: String, enum: ['draft', 'published'], default: 'published' },
  publishAt: { type: Date, default: Date.now },

  publishedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// --- GEO helpers (added) ---
function matchGeoToken(token, { country, region, city } = {}) {
  if (!token) return false;
  const [kind, c, sub] = token.split(':');

  if (kind === 'country') {
    return !!country && country.toUpperCase() === (c || '').toUpperCase();
  }
  if (kind === 'state') {
    return !!country && !!region &&
      country.toUpperCase() === (c || '').toUpperCase() &&
      region.toUpperCase() === (sub || '').toUpperCase();
  }
  if (kind === 'city') {
    return !!country && !!city &&
      country.toUpperCase() === (c || '').toUpperCase() &&
      String(city).toLowerCase() === (sub || '').toLowerCase();
  }
  return false;
}

articleSchema.methods.isAllowedForGeo = function isAllowedForGeo(geo) {
  const { geoMode, geoAreas } = this;
  if (!geo || geoMode === 'global' || !Array.isArray(geoAreas) || geoAreas.length === 0) return true;

  const matches = geoAreas.some(t => matchGeoToken(t, geo));
  if (geoMode === 'include') return matches;
  if (geoMode === 'exclude') return !matches;
  return true;
};

// Optional index useful for public queries
articleSchema.index({ status: 1, publishAt: 1, createdAt: -1 });

const Article = mongoose.model('Article', articleSchema);

// Auth helpers
function signToken() { return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '6h' }); }
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error('not admin');
    req.user = { role: 'admin' };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth (public by default; admin if token present)
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role === 'admin') req.user = { role: 'admin' };
  } catch { /* ignore */ }
  next();
}

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Auth
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: signToken() });
});

// Cloudinary signed upload
app.post('/api/uploads/sign', auth, (req, res) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = { timestamp, folder: CLOUDINARY_FOLDER };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, CLOUDINARY_API_SECRET);
  res.json({
    timestamp,
    signature,
    apiKey: CLOUDINARY_API_KEY,
    cloudName: CLOUDINARY_CLOUD_NAME,
    folder: CLOUDINARY_FOLDER
  });
});

// ---------- Articles ----------

// Paginated list (supports ?page, ?limit, ?q, ?category, ?all=1 for admin)
app.get('/api/articles', optionalAuth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();

  const isAdmin = req.user?.role === 'admin';
  const includeAll = isAdmin && req.query.all === '1';

  const query = {};
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ title: rx }, { summary: rx }, { author: rx }];
  }
  if (category && category !== 'All') {
    query.category = category;
  }

  // Hide drafts & future posts for public; admin can opt-in with all=1
  if (!includeAll) {
    query.status = 'published';
    query.publishAt = { $lte: new Date() };
  }

  const total = await Article.countDocuments(query);
  const items = await Article.find(query)
    .sort({ publishedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  // --- GEO enforcement (public only) ---
  const enforceGeo = !isAdmin;
  const geo = req.geo || {};
  const visibleItems = enforceGeo
    ? items.filter(a => (new Article(a)).isAllowedForGeo(geo))
    : items;

  const mapped = visibleItems.map(a => ({ ...a, id: a._id, publishedAt: a.publishedAt }));

  // Public cache headers (admin responses are private/uncached)
  if (!isAdmin) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  }

  res.json({
    items: mapped,
    page,
    pageSize: limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total
  });
});

// by id (admin tooling; no visibility filter)
app.get('/api/articles/:id', async (req, res) => {
  try {
    const a = await Article.findById(req.params.id).lean();
    if (!a) return res.status(404).json({ error: 'Not found' });
    res.json({ ...a, id: a._id, publishedAt: a.publishedAt });
  } catch {
    res.status(400).json({ error: 'Bad id' });
  }
});

// by slug (public: enforce live visibility; admin token can see anything)
app.get('/api/articles/slug/:slug', optionalAuth, async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const filter = { slug: req.params.slug };
  if (!isAdmin) {
    filter.status = 'published';
    filter.publishAt = { $lte: new Date() };
  }
  const a = await Article.findOne(filter).lean();
  if (!a) return res.status(404).json({ error: 'Not found' });

  // --- GEO enforcement (public only) ---
  if (!isAdmin) {
    const allowed = (new Article(a)).isAllowedForGeo(req.geo || {});
    if (!allowed) return res.status(404).json({ error: 'Not found' }); // soft-block
  }

  // Public cache headers
  if (!isAdmin) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  }

  res.json({ ...a, id: a._id, publishedAt: a.publishedAt });
});

// Create
app.post('/api/articles', auth, async (req, res) => {
  const {
    title, summary, author, body, category = 'General',
    imageUrl, imagePublicId,
    // NEW
    status = 'published',
    publishAt,
    // NEW (GEO accept)
    geoMode,
    geoAreas
  } = req.body || {};

  if (!title || !summary || !author || !body) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // sanitize GEO
  const allowedModes = ['global', 'include', 'exclude'];
  const sanitizedGeoMode = allowedModes.includes(String(geoMode)) ? String(geoMode) : 'global';
  const sanitizedGeoAreas = Array.isArray(geoAreas)
    ? geoAreas.map(s => String(s).trim()).filter(Boolean)
    : [];

  const slug = await uniqueSlugForTitle(title);
  const doc = await Article.create({
    title, slug, summary, author, body, category, imageUrl, imagePublicId,
    status,
    publishAt: publishAt ? new Date(publishAt) : new Date(),
    publishedAt: new Date(),
    // save GEO
    geoMode: sanitizedGeoMode,
    geoAreas: sanitizedGeoAreas
  });
  res.status(201).json({ ...doc.toObject(), id: doc._id });
});

// Edit (slug is stable)
app.patch('/api/articles/:id', auth, async (req, res) => {
  const {
    title, summary, author, body, category, imageUrl, imagePublicId,
    // NEW
    status, publishAt,
    // NEW (GEO accept)
    geoMode, geoAreas
  } = req.body || {};
  const update = {};
  if (title !== undefined) update.title = title;
  if (summary !== undefined) update.summary = summary;
  if (author !== undefined) update.author = author;
  if (body !== undefined) update.body = body;
  if (category !== undefined) update.category = category;
  if (imageUrl !== undefined) update.imageUrl = imageUrl;
  if (imagePublicId !== undefined) update.imagePublicId = imagePublicId;
  if (status !== undefined) update.status = status;
  if (publishAt !== undefined) update.publishAt = new Date(publishAt);

  // sanitize + set GEO if provided
  if (geoMode !== undefined) {
    const allowedModes = ['global', 'include', 'exclude'];
    update.geoMode = allowedModes.includes(String(geoMode)) ? String(geoMode) : 'global';
  }
  if (geoAreas !== undefined) {
    update.geoAreas = Array.isArray(geoAreas)
      ? geoAreas.map(s => String(s).trim()).filter(Boolean)
      : [];
  }

  try {
    const doc = await Article.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ ...doc.toObject(), id: doc._id });
  } catch {
    res.status(400).json({ error: 'Bad id' });
  }
});

// Delete + Cloudinary cleanup
app.delete('/api/articles/:id', auth, async (req, res) => {
  try {
    const doc = await Article.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.imagePublicId) {
      try { await cloudinary.uploader.destroy(doc.imagePublicId); } catch (e) { console.warn('Cloudinary cleanup error:', e.message); }
    }
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Bad id' });
  }
});

// Seed
app.get('/api/dev/seed', async (_req, res) => {
  const count = await Article.countDocuments();
  if (count === 0) {
    const slug = await uniqueSlugForTitle('Welcome to Your News Site');
    await Article.create({
      title: 'Welcome to Your News Site',
      slug,
      summary: 'This is a demo article served from MongoDB.',
      author: 'System',
      category: 'General',
      body: 'You can replace this with real content later.',
      status: 'published',
      publishAt: new Date(),
      publishedAt: new Date()
    });
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;

// ---- Frontend base URL for all public links (articles, sitemap, rss) ----
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || 'https://news-site-frontend-sigma.vercel.app';

// -------- RSS & Sitemap --------
const SITE_URL = FRONTEND_BASE_URL; // keep old name for the rest of the code

function xmlEscape(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// --- Meta description helpers ---
function stripHtml(s = '') {
  return String(s).replace(/<[^>]*>/g, '');
}
function buildDescription(doc) {
  const raw = (doc?.summary && doc.summary.trim())
    || stripHtml(doc?.body || '').slice(0, 200);  // fallback to body
  // collapse whitespace and cap ~160 chars (good SERP length)
  return String(raw).replace(/\s+/g, ' ').slice(0, 160);
}

// ====== SEO additions (helpers) ======
const HREFLANGS = [
  { lang: 'x-default', code: 'x-default' },
  { lang: 'en-US', code: 'en-US' },
  { lang: 'en-IN', code: 'en-IN' },
];

function buildHreflangLinks(url) {
  return HREFLANGS.map(h =>
    `<xhtml:link rel="alternate" hreflang="${h.code}" href="${xmlEscape(url)}" />`
  ).join('');
}

// ---------- Server-rendered Article HTML with SEO (for validators) ----------
function htmlEscape(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * EXISTING validator/helper page at backend /article/:slug
 * (left unchanged)
 */
app.get('/article/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;

    // Public visibility rules (same as your API)
    const filter = { slug, status: 'published', publishAt: { $lte: new Date() } };
    const doc = await Article.findOne(filter).lean();
if (!doc) return res.status(404).send('Not found');

// 🆕 allow trusted crawlers to bypass GEO on the SSR page
const ua = String(req.headers['user-agent'] || '');
const isTrustedBot = /Googlebot|AdsBot|bingbot|DuckDuckBot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot/i.test(ua);

// GEO enforcement (public) — skip for trusted bots
if (!isTrustedBot) {
  const allowed = (new Article(doc)).isAllowedForGeo(req.geo || {});
  if (!allowed) return res.status(404).send('Not found');
}


    const pageUrl = `${SITE_URL}/article/${encodeURIComponent(slug)}`;

    const title = doc.title || 'Article';
    const description = buildDescription(doc);

    const ogImage = doc.imageUrl || '';
    const published = doc.publishedAt || doc.publishAt || doc.createdAt || new Date();
    const modified = doc.updatedAt || published;

    // JSON-LD Article schema
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": title,
      "description": description,
      "image": ogImage ? [ogImage] : undefined,
      "datePublished": new Date(published).toISOString(),
      "dateModified": new Date(modified).toISOString(),
      "author": doc.author ? { "@type": "Person", "name": doc.author } : undefined,
      "mainEntityOfPage": {
        "@type": "WebPage",
        "@id": pageUrl
      }
    };

    const hrefLangs = [
      { lang: 'x-default', url: pageUrl },
      { lang: 'en-US',    url: pageUrl },
      { lang: 'en-IN',    url: pageUrl },
    ].map(h => `<link rel="alternate" hreflang="${h.lang}" href="${htmlEscape(h.url)}" />`).join('\n  ');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <link rel="canonical" href="${htmlEscape(pageUrl)}" />
  <meta name="description" content="${htmlEscape(description)}" />
  <meta name="robots" content="index,follow" />

  <!-- Open Graph -->
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${htmlEscape(title)}" />
  <meta property="og:description" content="${htmlEscape(description)}" />
  <meta property="og:url" content="${htmlEscape(pageUrl)}" />
  ${ogImage ? `<meta property="og:image" content="${htmlEscape(ogImage)}" />` : ''}

  <!-- Twitter -->
  <meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${htmlEscape(title)}" />
  <meta name="twitter:description" content="${htmlEscape(description)}" />
  ${ogImage ? `<meta name="twitter:image" content="${htmlEscape(ogImage)}" />` : ''}

  ${hrefLangs}

  <!-- JSON-LD -->
  <script type="application/ld+json">
  ${JSON.stringify(jsonLd)}
  </script>
</head>
<body>
  <!-- App root (your SPA will hydrate below) -->
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>`;

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.type('html').send(html);
  } catch (e) {
    console.error('SSR article error:', e);
    res.status(500).send('server render failed');
  }
});

/* =========================
   NEW: Crawler-friendly SSR
   =========================
   /ssr/article/:slug -> plain HTML + NewsArticle JSON-LD
   Canonical points to FRONTEND_BASE_URL/article/:slug (your SPA)
*/
function buildNewsArticleJSONLD(a, url) {
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": a.title,
    "datePublished": new Date(a.publishedAt || a.createdAt || Date.now()).toISOString(),
    "dateModified": new Date(a.updatedAt || a.publishedAt || a.createdAt || Date.now()).toISOString(),
    "author": a.author ? [{ "@type": "Person", "name": a.author }] : undefined,
    "articleSection": a.category || "General",
    "image": a.imageUrl ? [a.imageUrl] : undefined,
    "mainEntityOfPage": { "@type": "WebPage", "@id": url },
    "url": url,
    "description": a.summary || ""
  };
}

app.get('/ssr/article/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // Enforce public visibility + GEO (same as API)
    const filter = { slug, status: 'published', publishAt: { $lte: new Date() } };
    const a = await Article.findOne(filter).lean();
    if (!a) return res.status(404).send('Not found');

    if (!(new Article(a)).isAllowedForGeo(req.geo || {})) {
      return res.status(404).send('Not found');
    }

    // Canonical = SPA article URL
    const canonicalUrl = `${FRONTEND_BASE_URL}/article/${encodeURIComponent(slug)}`;
    // Self URL = this backend SSR page
    const selfUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    const desc = buildDescription(a);
    const jsonLd = buildNewsArticleJSONLD(a, selfUrl);

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${htmlEscape(a.title)} – My News</title>

  <!-- Canonical to SPA -->
  <link rel="canonical" href="${htmlEscape(canonicalUrl)}"/>

  <!-- Basic SEO & social -->
  <meta name="description" content="${htmlEscape(desc)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="${htmlEscape(a.title)}"/>
  <meta property="og:description" content="${htmlEscape(desc)}"/>
  <meta property="og:url" content="${htmlEscape(selfUrl)}"/>
  ${a.imageUrl ? `<meta property="og:image" content="${htmlEscape(a.imageUrl)}"/>` : ''}

  <meta name="twitter:card" content="${a.imageUrl ? 'summary_large_image' : 'summary'}"/>
  <meta name="twitter:title" content="${htmlEscape(a.title)}"/>
  <meta name="twitter:description" content="${htmlEscape(desc)}"/>
  ${a.imageUrl ? `<meta name="twitter:image" content="${htmlEscape(a.imageUrl)}"/>` : ''}

  <!-- JSON-LD -->
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>

  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f8fafc;margin:0}
    .wrap{max-width:980px;margin:0 auto;padding:24px}
    .card{background:#fff;border:1px solid #eee;border-radius:12px;padding:16px}
    img.hero{width:100%;max-height:420px;object-fit:cover;border-radius:12px;margin:0 0 12px}
    small.muted{color:#666}
    hr{border:0;height:1px;background:#f0f0f0;margin:12px 0}
    a.back{color:#1B4965;text-decoration:none}
  </style>
</head>
<body>
  <div class="wrap">
    <p><a class="back" href="${htmlEscape(canonicalUrl)}">← View on site</a></p>
    <article class="card">
      ${a.imageUrl ? `<img class="hero" src="${htmlEscape(a.imageUrl)}" alt=""/>` : ''}
      <h1 style="margin-top:0">${htmlEscape(a.title)}</h1>
      <small class="muted">${new Date(a.publishedAt).toLocaleString()} • ${htmlEscape(a.author || '')} • ${htmlEscape(a.category || 'General')}</small>
      <hr/>
      <div style="line-height:1.7;white-space:pre-wrap">${htmlEscape(a.body || '')}</div>
    </article>
  </div>
</body>
</html>`;

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.set('Content-Type', 'text/html; charset=utf-8').status(200).send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

// RSS 2.0 feed
app.get('/rss.xml', async (req, res) => {
  try {
    const docs = await Article.find({
      status: 'published',
      publishAt: { $lte: new Date() }
    })
      .sort({ publishedAt: -1 })
      .limit(100)
      .lean();

    // --- GEO enforcement for public feeds ---
    const geo = req.geo || {};
    const items = docs.filter(d => (new Article(d)).isAllowedForGeo(geo));

    const feedItems = items.map(a => {
      const link = `${SITE_URL}/article/${encodeURIComponent(a.slug)}`;
      const pubDate = new Date(a.publishedAt || a.createdAt || Date.now()).toUTCString();
      const enclosure = a.imageUrl
        ? `<enclosure url="${xmlEscape(a.imageUrl)}" type="image/jpeg" />`
        : '';
      return `
        <item>
          <title>${xmlEscape(a.title)}</title>
          <link>${xmlEscape(link)}</link>
          <guid isPermaLink="false">${xmlEscape(String(a._id))}</guid>
          <pubDate>${pubDate}</pubDate>
          <description><![CDATA[${a.summary || ''}]]></description>
          ${enclosure}
        </item>`;
    }).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape('My News')}</title>
    <link>${xmlEscape(SITE_URL)}</link>
    <description>${xmlEscape('Latest articles from My News')}</description>
    <language>en</language>
    ${feedItems}
  </channel>
</rss>`;

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.set('Content-Type', 'application/rss+xml; charset=utf-8').send(xml);
  } catch (e) {
    console.error('rss.xml error:', e);
    res.status(500).send('rss generation failed');
  }
});

// XML Sitemap (with hreflang)
app.get('/sitemap.xml', async (req, res) => {
  try {
    const docs = await Article.find({
      status: 'published',
      publishAt: { $lte: new Date() }
    })
      .sort({ publishedAt: -1 })
      .limit(5000)
      .lean();

    // --- GEO enforcement for public sitemap ---
    const geo = req.geo || {};
    const articles = docs.filter(d => (new Article(d)).isAllowedForGeo(geo));

    // Core pages
    const urls = [
      { loc: SITE_URL, changefreq: 'hourly', priority: '1.0' },
      { loc: `${SITE_URL}/category/Politics`, changefreq: 'daily', priority: '0.6' },
      { loc: `${SITE_URL}/category/Business`, changefreq: 'daily', priority: '0.6' },
      { loc: `${SITE_URL}/category/Tech`, changefreq: 'daily', priority: '0.6' },
      { loc: `${SITE_URL}/category/Sports`, changefreq: 'daily', priority: '0.6' },
      { loc: `${SITE_URL}/category/Entertainment`, changefreq: 'daily', priority: '0.6' },
      { loc: `${SITE_URL}/category/World`, changefreq: 'daily', priority: '0.6' },
    ];

    const articleUrlEntries = articles.map(a => {
      const loc = `${SITE_URL}/article/${encodeURIComponent(a.slug)}`;
      const lastmod = new Date(a.updatedAt || a.publishedAt || Date.now()).toISOString();
      return `
  <url>
    <loc>${xmlEscape(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    ${buildHreflangLinks(loc)}
  </url>`;
    }).join('');

    const coreUrlEntries = urls.map(u => `
  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    ${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}
    ${u.priority ? `<priority>${u.priority}</priority>` : ''}
    ${buildHreflangLinks(u.loc)}
  </url>`).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml"
>
${coreUrlEntries}
${articleUrlEntries}
</urlset>`;

    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=1200, stale-while-revalidate=3600');
    res.set('Content-Type', 'application/xml; charset=utf-8').send(xml);
  } catch (e) {
    console.error('sitemap.xml error:', e);
    res.status(500).send('sitemap generation failed');
  }
});

// Google News Sitemap (last 48 hours)
app.get('/news-sitemap.xml', async (req, res) => {
  try {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const docs = await Article.find({
      status: 'published',
      publishAt: { $lte: new Date() },
      publishedAt: { $gte: twoDaysAgo }
    })
      .sort({ publishedAt: -1 })
      .limit(1000)
      .lean();

    // GEO enforcement (public)
    const geo = req.geo || {};
    const items = docs.filter(d => (new Article(d)).isAllowedForGeo(geo));

    const urlItems = items.map(a => {
      const loc = `${SITE_URL}/article/${encodeURIComponent(a.slug)}`;
      const pubDate = new Date(a.publishedAt || a.createdAt || Date.now()).toISOString();
      const title = a.title || 'Article';

      return `
  <url>
    <loc>${xmlEscape(loc)}</loc>
    <news:news>
      <news:publication>
        <news:name>${xmlEscape(PUBLICATION_NAME)}</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${pubDate}</news:publication_date>
      <news:title>${xmlEscape(title)}</news:title>
    </news:news>
  </url>`;
    }).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
>
${urlItems}
</urlset>`;

    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=1200, stale-while-revalidate=3600');
    res.set('Content-Type', 'application/xml; charset=utf-8').send(xml);
  } catch (e) {
    console.error('news-sitemap.xml error:', e);
    res.status(500).send('news sitemap generation failed');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('API listening on', PORT);
});
