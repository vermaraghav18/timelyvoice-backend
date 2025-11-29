// 4) Core deps
const fs = require('fs');
const slugify = require('slugify');
const express = require('express');
const compression = require('compression');
const jwt = require('jsonwebtoken');
const listEndpoints = require('express-list-endpoints');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const mongoose = require('mongoose');
const { Types } = mongoose;

// ⬇️ Prerender.io
const prerender = require('prerender-node');

function escapeRegex(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const cookieParser = require('cookie-parser');
const multer = require('multer');
const stream = require('stream');

// 5) Middleware & routers
const analyticsBotFilter = require('./middleware/analyticsBotFilter');
const analyticsRouter = require('./routes/analytics');
const robotsRoute = require('./src/routes/robots');
const {
  router: sitemapRouter,
  markSitemapDirty,
  setModels: setSitemapModels
} = require('./src/routes/sitemap');

const geoMiddleware = require('./middleware/geo');
const breakingRoutes = require('./routes/breaking');
const tickerRoutes = require('./routes/ticker');
const sectionsRouter = require('./src/routes/sections');
const sectionsV2 = require('./src/routes/sectionsV2');
const adminAdsRouter = require('./src/routes/admin.ads.routes');
const planImageRoutes = require('./src/routes/planImage.routes');
const articlesRouter = require('./src/routes/articles');
const historyPageRoutes = require('./src/routes/historyPageRoutes');

// 6) Models registered early
const Article = require('./src/models/Article');
const XSource = require('./src/models/XSource');
const XItem   = require('./src/models/XItem');

// Comments & newsletter models (used by their routers below)
const Comment = require('./models/Comment');
const Subscriber = require('./models/Subscriber');
const rssTopNewsRouter = require('./src/routes/rss.topnews');

// 7) Cron jobs
require('./cron');

// 9) App init
const app = express();

// ---------------- Prerender.io integration ----------------
prerender.set('prerenderToken', process.env.PRERENDER_TOKEN);

// Important to ignore static assets and APIs
prerender.set('whitelisted', ['/']);
prerender.set('blacklisted', [
  '^/api',
  '\\.css$',
  '\\.js$',
  '\\.png$',
  '\\.jpg$',
  '\\.jpeg$',
  '\\.svg$',
  '\\.gif$',
  '\\.webp$'
]);

app.use(prerender);

// ✅ Safe static assets mount (won’t crash if frontend/dist doesn’t exist)
//const distAssets = path.join(__dirname, '../frontend/dist/assets');
//if (fs.existsSync(distAssets)) {
  //app.use('/assets', express.static(distAssets, { maxAge: '1y', immutable: true }));
  //console.log('[static] Serving /assets from', distAssets);
//} else {
  //console.warn('[static] frontend dist assets not found, skipping /assets mount');
//}

app.use(cookieParser());

const urlNormalize = require('./url-normalize');
app.use(urlNormalize);

// Simple ads.txt
app.get('/ads.txt', (_req, res) => {
  res.type('text/plain').send('google.com, pub-8472487092329023, DIRECT, f08c47fec0942fa0');
});

/* -------------------- Tiny in-memory cache for hot GET endpoints -------------------- */
const cache = new Map(); // key -> { data, exp }

function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(key); return null; }
  return v.data;
}
function setCache(key, data, ttlMs = 60_000) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}
function cacheRoute(ttlMs = 60_000) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = req.originalUrl;
    const hit = getCache(key);
    if (hit) {
      console.log('⚡ Cache HIT:', key);
      return res.json(hit);
    }
    const send = res.json.bind(res);
    res.json = (body) => {
      setCache(key, body, ttlMs);
      return send(body);
    };
    next();
  };
}

/* -------------------- CORS (unified) -------------------- */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// sensible defaults if ALLOWED_ORIGINS not set
if (allowedOrigins.length === 0) {
  allowedOrigins.push(
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://timelyvoice.com',
    'https://www.timelyvoice.com',
    'https://news-site-frontend-sigma.vercel.app'
  );
}

const corsOptions = {
  origin(origin, cb) {
    // allow server-to-server, curl, health checks (no Origin header)
    if (!origin) return cb(null, true);
    const ok =
      allowedOrigins.includes(origin) ||
      /^http:\/\/localhost:5173$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:5173$/.test(origin);
    if (ok) return cb(null, true);
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[CORS] blocked origin:', origin, 'allowed:', allowedOrigins);
    }
    return cb(new Error('CORS not allowed for ' + origin), false);
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: [
    'Content-Type','Authorization','Cache-Control','Pragma',
    'If-Modified-Since','If-None-Match',
    'X-Geo-Preview-Country','X-Force-NonBot','X-Analytics-OptOut'
  ],
  maxAge: 86400
};
// mount CORS BEFORE routes
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Trust reverse proxy only when explicitly enabled (default true)
if (String(process.env.TRUST_PROXY || 'true') === 'true') {
  app.set('trust proxy', 1);
}

// Compress all responses (JSON, HTML, etc.)
app.use(compression({ threshold: 0 }));

// ✅ Only enforce canonical domain/https in production
if (process.env.NODE_ENV === 'production') {
  const canonicalHost = require('./src/middleware/canonicalHost');
  app.use(canonicalHost());
}

// Strong ETags let browsers/CDNs validate cached JSON quickly
app.set('etag', 'strong');

// Cache public GET endpoints so repeat visits are instant
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();

  // Do NOT cache anything under admin/auth/uploads/etc.
  const noCachePrefixes = ['/api/admin', '/api/auth', '/api/upload', '/api/media/upload'];
  if (noCachePrefixes.some(p => req.path.startsWith(p))) {
    res.set('Cache-Control', 'no-store');
    return next();
  }

  // Apply caching to ALL other /api/* GETs
  const isApi = req.path.startsWith('/api/');
  if (isApi) {
    // Default for lists/sections
    let header = 'public, max-age=60, s-maxage=300, stale-while-revalidate=30';

    // Slightly longer for single-article reads
    const isSingleArticle = /^\/api\/(public\/articles\/|articles\/)/.test(req.path) && !req.query.q;
    if (isSingleArticle) {
      header = 'public, max-age=300, s-maxage=1200, stale-while-revalidate=60';
    }
    res.set('Cache-Control', header);
  }
  next();
});

// Body parsers
// 1) JSON for normal APIs (login, single-article create/update, etc.)
app.use(express.json({ limit: '10mb' }));
// 2) Text for NDJSON (bulk import) and plain text
app.use(express.text({
  type: ['text/plain', 'application/x-ndjson'],
  limit: '10mb'
}));

// Automation routes
const automationRouter = require("./src/routes/automation");
app.use("/api/automation", automationRouter);

// Debug: openrouter env check
app.get("/api/automation/_debug/openrouter", (req, res) => {
  res.json({
    keyPresent: !!process.env.OPENROUTER_API_KEY,
    keyPrefix: process.env.OPENROUTER_API_KEY?.slice(0, 10) || null,
    cwd: process.cwd(),
    envFileExpectedAt: require("path").resolve(__dirname, ".env")
  });
});

// Admin articles router
const adminArticlesRouter = require('./src/routes/admin.articles.routes');
app.use('/api/admin/articles', adminArticlesRouter);

// robots + cached high-traffic endpoints
app.use("/", robotsRoute);
app.use("/rss", rssTopNewsRouter);  
app.use('/api/breaking',  cacheRoute(30_000), breakingRoutes);
app.use('/api/ticker',    cacheRoute(30_000), tickerRoutes);
app.use('/api/sections',  cacheRoute(60_000), sectionsRouter);
app.use('/api/top-news',  cacheRoute(30_000), require("./src/routes/topnews"));

app.use('/api/plan-image', planImageRoutes);
// History Page (Public + Admin)
app.use("/api/history-page", historyPageRoutes);


// Cache helpers
function clearCache(prefix = '') {
  for (const key of cache.keys()) {
    if (!prefix || key.startsWith(prefix)) cache.delete(key);
  }
}

// Bot detection + SSR cache for crawlers
const BOT_UA =
  /Googlebot|AdsBot|bingbot|DuckDuckBot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot/i;

function isBot(req) {
  const ua = String(req.headers['user-agent'] || '');
  return BOT_UA.test(ua);
}

// ultra-simple TTL cache for prerendered HTML
const SSR_CACHE = new Map(); // key -> { html, exp }
function ssrCacheGet(key) {
  const hit = SSR_CACHE.get(key);
  if (!hit) return null;
  if (hit.exp <= Date.now()) { SSR_CACHE.delete(key); return null; }
  return hit.html;
}
function ssrCacheSet(key, html, ttlMs = 60_000) { // 60s cache
  SSR_CACHE.set(key, { html, exp: Date.now() + ttlMs });
}

// --- Serve SSR (server-side rendered) pages to crawlers ---
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/article/")) return next();
  // Try SSR cache for bots early
  if (isBot(req)) {
    const slugForCache = req.path.slice("/article/".length);
    const cached = ssrCacheGet(`ssr:article:${slugForCache}`);
    if (cached) {
      res.setHeader('Cache-Control','public, max-age=60, s-maxage=300, stale-while-revalidate=600');
      return res.status(200).type('html').send(cached);
    }
  }
  if (!isBot(req)) return next(); // humans → SPA/front-end

  const slug = req.path.slice("/article/".length);
  try {
    // build base from the incoming request host (works locally and in prod)
    const base = `${req.protocol}://${req.get('host')}`;
    const url  = `${base}/ssr/article/${encodeURIComponent(slug)}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`SSR fetch ${r.status}`);
    const html = await r.text();

    // cache for bots
    ssrCacheSet(`ssr:article:${slug}`, html, 60_000);
    res.setHeader('Cache-Control','public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).type('html').send(html);
  } catch (err) {
    console.error("SSR middleware failed:", err.message);
    return next(); // fallback to SPA
  }
});

// Admin ads
app.use("/api/admin/ads", adminAdsRouter);

// Return a clean message if an origin is not allowed by CORS
app.use((err, req, res, next) => {
  if (err && err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: 'CORS blocked for this origin' });
  }
  return next(err);
});

/* -------------------- GEO & Bot filter -------------------- */
app.use(geoMiddleware());
app.use(analyticsBotFilter());

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

/* -------------------- X-Robots-Tag for sensitive paths -------------------- */
app.use((req, res, next) => {
  // Mark admin and all API endpoints as non-indexable
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin')) {
    res.setHeader('X-Robots-Tag', 'noindex');
  }
  next();
});

/* -------------------- Analytics endpoints -------------------- */
const collectLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAX || '300', 10),              // 300 req/min/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});

// --- Login brute-force guard ---
const LOGIN_WINDOW_MS = parseInt(process.env.LOGIN_WINDOW_MS || '900000', 10); // 15 minutes
const LOGIN_MAX = parseInt(process.env.LOGIN_MAX || '20', 10);                 // 20 attempts / window / IP
const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

app.use('/api/analytics/collect', collectLimiter);
app.use('/api/analytics', analyticsRouter);

// ✅ Simple collector endpoint for frontend pings
app.post('/api/analytics/collect', (req, res) => {
  res.status(204).end();
});

/* -------------------- ENV -------------------- */
const {
  ADMIN_PASSWORD, JWT_SECRET, MONGO_URI,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_FOLDER = 'news-site',
  PUBLICATION_NAME = 'My News'
} = process.env;

// Frontend canonical base (used by SSR/feeds)
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://timelyvoice.com';
const SITE_URL = FRONTEND_BASE_URL; // kept for backward-compat code
// Fallback image for feeds (also used by ensureRenderableImage)
const SITE_LOGO = process.env.SITE_LOGO || `${SITE_URL.replace(/\/$/, '')}/logo-192.png`;

/* -------------------- Admin-only guard for X-Geo-Preview-Country -------------------- */
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

// TEMP: Inspect req.geo (for testing) — placed AFTER the guard
app.get('/api/dev/echo-geo', (req, res) => {
  res.json({ geo: req.geo });
});

app.get('/api/dev/cloudinary-config', (_req, res) => {
  const cfg = require('./src/lib/cloudinary').config();
  res.json({
    cloud_name: cfg.cloud_name || null,
    has_key: !!cfg.api_key,
    secure: cfg.secure === true
  });
});

app.get('/api/dev/test-image-pick', async (req, res) => {
  const title    = String(req.query.title || '');
  const tags     = String(req.query.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const category = String(req.query.category || '');

  const picked = await pickBestImageForArticle({ title, tags, category });
  res.json({ title, tags, category, picked });
});

// Quick Nitter RSS probe: /api/dev/nitter-probe?handle=narendramodi
app.get('/api/dev/nitter-probe', async (req, res) => {
  try {
    const handle = String(req.query.handle || '').replace(/^@/, '');
    if (!handle) return res.status(400).json({ ok: false, error: 'handle required' });
    const { debugFetchTimeline } = require('./src/services/x.fetch');
    const out = await debugFetchTimeline({ handle, limit: 5 });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* -------------------- MongoDB -------------------- */
mongoose.set('strictQuery', true);
console.log('[env] MONGO_URI=%s', MONGO_URI);

mongoose.connect(MONGO_URI, { dbName: 'newsdb', autoIndex: true })
  .then(() => {
    const dbName = mongoose.connection?.db?.databaseName;
    console.log('✅ MongoDB connected to db:', dbName);
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

/* -------------------- Helpers -------------------- */
async function uniqueSlugForTitle(title = 'article') {
  const base = slugify(String(title), { lower: true, strict: true }) || 'article';
  let s = base;
  let i = 2;
  while (await Article.exists({ slug: s })) {
    s = `${base}-${i++}`;
  }
  return s;
}

// Estimate reading time (minutes) at ~200 wpm, min 1 if body exists
function estimateReadingTime(text = '') {
  const words = String(text || '').replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  return Math.max(1, Math.round(words / 200));
}

// Geo helper (pure function; works on lean docs too)
function isAllowedForGeoDoc(a = {}, geo = {}) {
  const mode  = String(a.geoMode || 'global');
  const areas = Array.isArray(a.geoAreas)
    ? a.geoAreas.map(s => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  const country = String(geo.country || '').trim().toUpperCase();

  if (!country || mode === 'global') return true;
  if (mode === 'include') return areas.includes(country);
  if (mode === 'exclude') return !areas.includes(country);
  return true; // default allow
}

/* -------------------- Redirects + Category/Tag/Media models -------------------- */
const redirectSchema = new mongoose.Schema({
  scope: { type: String, enum: ['article', 'category'], required: true }, // what type of slug
  from:  { type: String, required: true, unique: true, index: true },    // previous slug
  to:    { type: String, required: true, index: true },                  // new slug
  type:  { type: Number, enum: [301, 302, 308], default: 301 },          // HTTP semantics (for SSR/API decisions)
  hits:  { type: Number, default: 0 },
}, { timestamps: true });
redirectSchema.index({ scope: 1, from: 1 }, { unique: true });
const Redirect = mongoose.models.Redirect || mongoose.model('Redirect', redirectSchema);

async function createRedirect(scope, from, to, type = 301) {
  if (!from || !to || from === to) return null;
  try {
    const doc = await Redirect.findOneAndUpdate(
      { scope, from },
      { scope, from, to, type },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return doc;
  } catch (e) {
    console.warn('redirect upsert warn:', e?.message);
    return null;
  }
}
async function resolveRedirect(scope, from) {
  if (!from) return null;
  const r = await Redirect.findOne({ scope, from }).lean();
  return r || null;
}
async function bumpRedirectHit(id) {
  try { await Redirect.updateOne({ _id: id }, { $inc: { hits: 1 } }); } catch (_) {}
}

// Category & Tag
const catSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 50 },
  slug: { type: String, required: true, trim: true, unique: true, index: true },
  description: { type: String, maxlength: 200 },
  type: { type: String, enum: ['topic','state','city'], default: 'topic', index: true },
  previousSlugs: { type: [String], default: [] },
}, { timestamps: true });

const tagSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 40 },
  slug: { type: String, required: true, trim: true, unique: true, index: true }
}, { timestamps: true });

const Category = mongoose.models.Category || mongoose.model('Category', catSchema);
const Tag      = mongoose.models.Tag      || mongoose.model('Tag', tagSchema);

// Media
const mediaSchema = new mongoose.Schema({
  url:        { type: String, required: true },     // secure_url
  publicId:   { type: String, required: true, index: true }, // cloudinary public_id
  format:     { type: String },                     // jpg/png/webp
  bytes:      { type: Number },                     // file size
  width:      { type: Number },
  height:     { type: Number },
  mime:       { type: String },                     // e.g. image/jpeg
  createdBy:  { type: String, default: 'admin' },   // simple for now
}, { timestamps: true });
mediaSchema.index({ createdAt: -1 });
const Media    = mongoose.models.Media    || mongoose.model('Media', mediaSchema);

// SITEMAP models must be registered once
setSitemapModels({ Article, Category, Tag });
app.use(sitemapRouter);

/* -------------------- MEDIA helpers -------------------- */
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image/* allowed'));
    }
    cb(null, true);
  }
});

function bufferToStream(buffer) {
  const readable = new stream.Readable({ read() {} });
  readable.push(buffer);
  readable.push(null);
  return readable;
}

async function upsertMediaFromCloudinaryResource(res, createdBy = 'admin') {
  const doc = {
    url: res.secure_url,
    publicId: res.public_id,
    format: res.format,
    bytes: res.bytes,
    width: res.width,
    height: res.height,
    mime: res.resource_type === 'image' ? `image/${res.format}` : undefined,
    createdBy,
  };
  const saved = await Media.findOneAndUpdate(
    { publicId: doc.publicId },
    doc,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return saved;
}

// Build server-side image variants for a given Cloudinary public_id
function buildImageVariants(publicId) {
  if (!publicId) return { thumbUrl: undefined, ogUrl: undefined };
  const thumbUrl = cloudinary.url(publicId, { width: 400, height: 300, crop: "fill", format: "webp" });
  const ogUrl    = cloudinary.url(publicId, { width: 1200, height: 630, crop: "fill", format: "jpg" });
  return { thumbUrl, ogUrl };
}

// Slug helpers for Category/Tag
async function ensureUniqueCategorySlug(name, desired) {
  const base = slugify(desired || name);
  let s = base, i = 2;
  while (await Category.exists({ slug: s })) s = `${base}-${i++}`;
  return s;
}
async function ensureUniqueTagSlug(name, desired) {
  const base = slugify(desired || name);
  let s = base, i = 2;
  while (await Tag.exists({ slug: s })) s = `${base}-${i++}`;
  return s;
}

// Auth helpers
function signToken() { return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '6h' }); }
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && req.cookies) token = req.cookies.token || null;
  try {
    const decoded = jwt.verify(token || '', JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error('not admin');
    req.user = { role: 'admin' };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or missing token' });
  }
}
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.token || null);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role === 'admin') req.user = { role: 'admin' };
    } catch { /* ignore */ }
  }
  next();
}

/* -------------------- Comments & Newsletter -------------------- */
const commentsRouterFactory = require('./routes/comments');
app.use(commentsRouterFactory(
  { Article, Comment },
  { requireAuthOptional: optionalAuth, requireAuthAdmin: auth }
));

const newsletterRouterFactory = require('./routes/newsletter');
app.use(newsletterRouterFactory(
  { Subscriber },
  { requireAuthAdmin: auth }
));

/* -------------------- Health & Auth -------------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Password strength advisory (does not block login)
  const configured = ADMIN_PASSWORD || '';
  const strongish =
    configured.length >= 8 &&
    /[A-Z]/.test(configured) &&
    /[a-z]/.test(configured) &&
    /\d/.test(configured) &&
    /[\W_]/.test(configured);
  if (!strongish) {
    console.warn('[auth] ADMIN_PASSWORD appears weak; consider rotating to a stronger one (8+ chars, upper/lower/digit/symbol).');
  }

  if (password !== configured) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: signToken() });
});

/* -------------------- Cloudinary signed upload -------------------- */
app.post('/api/uploads/sign', auth, (_req, res) => {
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

// ===== Bulk import helpers =====
function parseBulkBody(reqBody) {
  if (Array.isArray(reqBody)) return reqBody;
  if (typeof reqBody === 'string') {
    const trimmed = reqBody.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) return JSON.parse(trimmed); // JSON array
    // JSONL / NDJSON
    return trimmed.split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
  if (reqBody && Array.isArray(reqBody.items)) return reqBody.items;
  throw new Error('Provide an array of JSON objects or JSONL string');
}

// Normalize one incoming article to your DB shape
async function normalizeIncomingArticle(input = {}) {
  const {
    title, summary, author, body,
    category = 'General',
    imageUrl, imagePublicId,
    status = 'published',
    publishAt,
    geoMode,
    geoAreas,
    tags: incomingTags,
    imageAlt,
    metaTitle,
    metaDesc,
    ogImage,
  } = input || {};

  // normalize status early
  const allowedStatus = new Set(['draft', 'published']);
  const normalizedStatus = allowedStatus.has(String(status || 'draft').toLowerCase())
    ? String(status).toLowerCase()
    : 'draft';

  // compute publishAt/publishedAt based on normalizedStatus
  const finalPublishAt =
    publishAt ? new Date(publishAt)
              : (normalizedStatus === 'published' ? new Date() : undefined);

  if (!title || !summary || !author || !body) {
    throw new Error('Missing fields: title, summary, author, body are required');
  }

  // geo
  const allowedModes = ['global', 'include', 'exclude'];
  const sanitizedGeoMode = allowedModes.includes(String(geoMode)) ? String(geoMode) : 'global';
  const sanitizedGeoAreas = Array.isArray(geoAreas)
    ? geoAreas.map(s => String(s).trim()).filter(Boolean)
    : [];

  // category by _id OR slug OR name => store canonical name
  let categoryName = category;
  {
    const ors = [
      { slug: slugify(String(category || '')) },
      { name: String(category || '') }
    ];
    if (category && mongoose.Types.ObjectId.isValid(String(category))) {
      ors.push({ _id: category });
    }
    const foundCat = await Category.findOne({ $or: ors }).lean();
    if (foundCat) categoryName = foundCat.name;
  }

  // tags by slug or name → store names
  const rawTags = Array.isArray(incomingTags) ? incomingTags : [];
  const tagsByName = [];
  for (const t of rawTags) {
    const nameOrSlug = String(t).trim();
    if (!nameOrSlug) continue;
    const tagDoc = await Tag.findOne({ $or: [{ slug: slugify(nameOrSlug) }, { name: nameOrSlug }] }).lean();
    tagsByName.push(tagDoc ? tagDoc.name : nameOrSlug);
  }

  // unique slug
  const slug = await uniqueSlugForTitle(title);

  /* >>> Auto-pick an image if none provided <<< */
  let finalImagePublicId = imagePublicId;
  let finalImageUrl      = imageUrl;
  let finalOgImage       = ogImage;

  if (!finalImagePublicId && !finalImageUrl &&
      String(process.env.CLOUDINARY_AUTOPICK || "").toLowerCase() === "on") {
    const picked = await pickBestImageForArticle({
      title,
      tags: tagsByName,
      category: categoryName
    });
    if (picked) {
      finalImagePublicId = picked.publicId;
      finalImageUrl      = picked.imageUrl;
      finalOgImage       = picked.ogImage;
    }
  }

  const doc = {
    title,
    slug,
    summary,
    author,
    body,
    category: categoryName,
    tags: tagsByName,

    imageUrl: finalImageUrl || imageUrl || '',
    imagePublicId: finalImagePublicId || imagePublicId || '',
    ogImage: finalOgImage || ogImage || '',

    imageAlt: (imageAlt || title || ''),
    metaTitle: (metaTitle || '').slice(0, 80),
    metaDesc: (metaDesc || '').slice(0, 200),

    readingTime: estimateReadingTime(body),

    status: normalizedStatus,
    publishAt: finalPublishAt,

    geoMode: sanitizedGeoMode,
    geoAreas: sanitizedGeoAreas
  };

  // only set publishedAt if actually published
  if (normalizedStatus === 'published') {
    doc.publishedAt = new Date();
  }

  await ensureArticleHasImage(doc);
  return doc;
}

/* -------------------- Auto image match (Cloudinary) -------------------- */
const STOP_WORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','at','by','with','is','are','was','were','be',
  'as','from','that','this','these','those','it','its','into','over','after','before','about','than',
  'new'
]);

function buildArticleKeywords({ title = '', tags = [], category = '' }) {
  const raw = [String(title || ''), String(category || ''), ...(Array.isArray(tags) ? tags : [])].join(' ');
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length >= 3 && !STOP_WORDS.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out.slice(0, 12);
}

async function searchCloudinaryByKeywords(keywords = []) {
  if (!keywords.length) return [];
  const folder = process.env.CLOUDINARY_FOLDER || 'news-images';
  const ors = keywords.map(k => `(tags=${k} OR public_id:${k} OR filename:${k})`);
  const expr = `folder=${folder} AND resource_type:image AND (${ors.join(' OR ')})`;
  const max = parseInt(process.env.CLOUDINARY_AUTOPICK_MAX || '40', 10);

  try {
    const res = await cloudinary.search
      .expression(expr)
      .sort_by('uploaded_at','desc')
      .with_field('tags')
      .max_results(Math.min(100, Math.max(10, max)))
      .execute();
    return Array.isArray(res?.resources) ? res.resources : [];
  } catch (e) {
    console.warn('[cloudinary.search] failed:', e?.message || e);
    return [];
  }
}

function scoreImage(resource, keywordsSet) {
  const id = String(resource.public_id || '').toLowerCase();
  const filename = id.split('/').pop(); // last segment
  const tags = (resource.tags || []).map(t => String(t).toLowerCase());
  let score = 0;
  for (const k of keywordsSet) {
    if (tags.includes(k)) score += 5;     // strong tag hit
    if (id.includes(k)) score += 3;       // id/public_id hit
    if (filename.includes(k)) score += 3; // filename hit
  }
  if (resource.width >= 1000) score += 2;
  if (resource.width >= 1600) score += 1;
  return score;
}

async function pickBestImageForArticle({ title, tags = [], category = '' }) {
  try {
    if (String(process.env.CLOUDINARY_AUTOPICK || 'on').toLowerCase() === 'off') return null;
    const keywords = buildArticleKeywords({ title, tags, category });
    if (!keywords.length) return null;
    const resources = await searchCloudinaryByKeywords(keywords);
    if (!resources.length) return null;

    const kwSet = new Set(keywords);
    let best = null;
    let bestScore = -1;
    for (const r of resources) {
      const s = scoreImage(r, kwSet);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (!best) return null;
    const publicId = best.public_id;
    const imageUrl = best.secure_url || cloudinary.url(publicId, { secure: true });
    const ogImage  = cloudinary.url(publicId, { width: 1200, height: 630, crop: 'fill', format: 'jpg', secure: true });
    return { imageUrl, imagePublicId: publicId, ogImage };
  } catch (e) {
    console.warn('[autopick-image] failed:', e?.message || e);
    return null;
  }
}

async function ensureArticleHasImage(payload = {}) {
  if (payload.imageUrl || payload.ogImage || payload.imagePublicId) return payload;
  const chosen = await pickBestImageForArticle({
    title: payload.title,
    tags: payload.tags,
    category: payload.category
  });
  if (chosen) {
    payload.imageUrl = chosen.imageUrl;
    payload.imagePublicId = chosen.imagePublicId;
    payload.ogImage = chosen.ogImage || payload.ogImage;
  }
  return payload;
}

/* -------------------- Articles API (public + admin) -------------------- */

// ⬇⬇⬇ ADD THIS WHOLE BLOCK ⬇⬇⬇
app.get('/api/history/timeline', async (req, res) => {
  try {
    // sort = "asc" or "desc" (default: desc = 4000 → 0)
    const sortParam = String(req.query.sort || 'desc').toLowerCase();
    const sortDir = sortParam === 'asc' ? 1 : -1;

    const fromYear = req.query.fromYear ? Number(req.query.fromYear) : null;
    const toYear   = req.query.toYear   ? Number(req.query.toYear)   : null;

    // Basic year filter: require year, and apply optional range
    const yearFilter = { $ne: null };
    if (!Number.isNaN(fromYear) && fromYear !== null) {
      yearFilter.$gte = fromYear;
    }
    if (!Number.isNaN(toYear) && toYear !== null) {
      yearFilter.$lte = toYear;
    }

    // We only want History articles.
    // category can be:
    //  - a simple string ("History")
    //  - an object { name, slug }
    const match = {
      status: 'published',
      year: yearFilter,
      $or: [
        { category: { $regex: /^history$/i } },
        { 'category.name': { $regex: /^history$/i } },
        { 'category.slug': { $regex: /^history$/i } },
      ],
    };

    // Safety limit: max 2000 items
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || '500', 10), 1),
      2000
    );

    const items = await Article.find(match)
      .sort({ year: sortDir, _id: 1 })
      .limit(limit)
      .select('title slug summary year era imageUrl ogImage publishedAt')
      .lean();

    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
    );
    res.json({ items, total: items.length });
  } catch (e) {
    console.error('GET /api/history/timeline failed:', e);
    res.status(500).json({ error: 'failed_to_load_history_timeline' });
  }
});
// ⬆⬆⬆ ADD THIS WHOLE BLOCK ⬆⬆⬆

// list
app.get('/api/articles', optionalAuth, async (req, res) => {
  const page  = Math.max(parseInt(req.query.page  || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);
  const qRaw  = String(req.query.q || '').trim();
  const catRaw= String(req.query.category || '').trim();

  const isAdmin    = req.user?.role === 'admin';
  const includeAll = isAdmin && String(req.query.all || '') === '1';

  const now = new Date();

  // Build $and of independent clauses
  const and = [];

  // Text search (safe regex)
  if (qRaw) {
    const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ title: rx }, { summary: rx }, { author: rx }] });
  }

  // Category filter (case-insensitive, supports string OR object {name, slug})
  if (catRaw && catRaw.toLowerCase() !== 'all') {
    const wantLower = String(catRaw).toLowerCase();
    and.push({
      $or: [
        // category stored as string
        {
          $and: [
            { $expr: { $eq: [ { $type: "$category" }, "string" ] } },
            { $expr: { $eq: [ { $toLower: "$category" }, wantLower ] } }
          ]
        },
        // category stored as object { name?, slug? }
        {
          $and: [
            { $expr: { $eq: [ { $type: "$category" }, "object" ] } },
            {
              $or: [
                { $expr: { $eq: [ { $toLower: { $ifNull: ["$category.name", ""] } }, wantLower ] } },
                { $expr: { $eq: [ { $toLower: { $ifNull: ["$category.slug", ""] } }, wantLower ] } }
              ]
            }
          ]
        }
      ]
    });
  }

  // Visibility (public users)
  if (!includeAll) {
    and.push({ status: 'published' });
    and.push({
      $or: [
        { publishedAt: { $lte: now } },
        { publishAt:   { $lte: now } },
        {
          $and: [
            { publishedAt: { $exists: false } },
            { publishAt:   { $exists: false } }
          ]
        }
      ]
    });
  }

  // Final match
  const match = and.length ? { $and: and } : {};

  // Coalesced sort key (freshest first)
  const coalesceSortKey = {
    $ifNull: [
      '$publishedAt',
      { $ifNull: [ '$publishAt', { $ifNull: [ '$updatedAt', '$createdAt' ] } ] }
    ]
  };

  // Shared pipeline
  const pipeline = [
    { $match: match },
  ];

  // Count
  const [{ total = 0 } = {}] = await Article.aggregate([
    ...pipeline,
    { $count: 'total' }
  ]);

  // Page (add sort and pagination)
  const items = await Article.aggregate([
    ...pipeline,
    { $addFields: { sortKey: coalesceSortKey } },
    { $sort: { sortKey: -1, _id: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit }
  ]);

  // GEO enforcement (public)
  const enforceGeo = !isAdmin;
  const geo = req.geo || {};
  const visible = enforceGeo ? items.filter(a => isAllowedForGeoDoc(a, geo)) : items;

  const normalizeCats = (val) => {
  if (!val) return val;
  if (Array.isArray(val)) return val.map(normalizeCats).filter(Boolean);
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    if (typeof val.name === 'string') return val.name;
    if (typeof val.slug === 'string') return val.slug;
    // ObjectId or unknown object → stringify
    try { return String(val); } catch { return null; }
  }
  return String(val);
};

const mapped = visible.map(a => ({
  ...a,
  id: a._id,
  publishedAt: a.publishedAt,
  category: normalizeCats(a.category),
  categories: normalizeCats(a.categories),
}));


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




// alias search (same logic so category pages don’t miss items when publishAt is null)
app.get('/api/articles/search', optionalAuth, async (req, res) => {
  const page   = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit  = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);
  const qRaw   = String(req.query.q || '').trim();
  const catRaw = String(req.query.category || '').trim();

  const isAdmin    = req.user?.role === 'admin';
  const includeAll = isAdmin && String(req.query.all || '') === '1';

  const now = new Date();
  const match = {};

  if (qRaw) {
    const rx = new RegExp(qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    match.$or = [{ title: rx }, { summary: rx }, { author: rx }];
  }

  if (catRaw && catRaw.toLowerCase() !== 'all') {
    const esc = catRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    match.category = { $regex: new RegExp(`^${esc}$`, 'i') };
  }

  const visibilityOr = includeAll ? [{}] : [
    { publishedAt: { $lte: now } },
    { publishAt:   { $lte: now } },
    { $and: [
        { publishedAt: { $exists: false } },
        { publishAt:   { $exists: false } }
      ] }
  ];

  if (!includeAll) match.status = 'published';

  const coalesceSortKey = {
    $ifNull: [
      '$publishedAt',
      { $ifNull: [ '$publishAt', { $ifNull: [ '$updatedAt', '$createdAt' ] } ] }
    ]
  };

  const base = [
    { $match: match },
    { $match: { $or: visibilityOr } },
    { $addFields: { sortKey: coalesceSortKey } },
  ];

  const [{ total = 0 } = {}] = await Article.aggregate([
    ...base,
    { $count: 'total' }
  ]);

  const items = await Article.aggregate([
    ...base,
    { $sort: { sortKey: -1, _id: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit }
  ]);

  const enforceGeo = !isAdmin;
  const geo = req.geo || {};
  const visibleItems = enforceGeo ? items.filter(a => isAllowedForGeoDoc(a, geo)) : items;

  const normalizeCats = (val) => {
  if (!val) return val;
  if (Array.isArray(val)) return val.map(normalizeCats).filter(Boolean);
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    if (typeof val.name === 'string') return val.name;
    if (typeof val.slug === 'string') return val.slug;
    try { return String(val); } catch { return null; }
  }
  return String(val);
};

const mapped = visibleItems.map(a => ({
  ...a,
  id: a._id,
  publishedAt: a.publishedAt,
  category: normalizeCats(a.category),
  categories: normalizeCats(a.categories),
}));


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

// read by id
app.get('/api/articles/:id', async (req, res) => {
  try {
    const a = await Article.findById(req.params.id).lean();
    if (!a) return res.status(404).json({ error: 'Not found' });
    res.json({ ...a, id: a._id, publishedAt: a.publishedAt });
  } catch {
    res.status(400).json({ error: 'Bad id' });
  }
});

// read by slug with redirects (public rules; admin token can see drafts)
app.get('/api/articles/slug/:slug', optionalAuth, async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const filter = { slug: req.params.slug };

  if (!isAdmin) {
    filter.status = 'published';
    const now = new Date();
    filter.$or = [
      { publishAt:   { $lte: now } },
      { publishedAt: { $lte: now } },
      { publishAt:   { $exists: false }, publishedAt: { $exists: false } }
    ];
  }

  let a = await Article.findOne(filter).lean();

  if (!a) {
    // Honor redirect
    const r = await resolveRedirect('article', req.params.slug);
    if (r) {
      bumpRedirectHit(r._id);
      res.setHeader('Location', `/api/articles/slug/${encodeURIComponent(r.to)}`);
      return res.status(308).json({ redirectTo: `/article/${r.to}` });
    }
    return res.status(404).json({ error: 'Not found' });
  }

  if (!isAdmin) {
    const allowed = isAllowedForGeoDoc(a, req.geo || {});
    if (!allowed) return res.status(404).json({ error: 'Not found' }); // soft-block
  }

  if (!isAdmin) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  }

  res.json({ ...a, id: a._id, publishedAt: a.publishedAt });
});

// create
app.post('/api/articles', auth, async (req, res) => {
  const {
    title, summary, author, body, category = 'General',
    imageUrl, imagePublicId,
    status = 'draft',
    publishAt,
    geoMode,
    geoAreas,
    tags: incomingTags,
    imageAlt,
    metaTitle,
    metaDesc,
    ogImage,
  } = req.body || {};

  // normalize status
  const allowedStatus = new Set(['draft', 'published']);
  const normalizedStatus = allowedStatus.has(String(status || 'draft').toLowerCase())
    ? String(status).toLowerCase()
    : 'draft';

  if (!title || !summary || !author || !body) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const allowedModes = ['global', 'include', 'exclude'];
  const sanitizedGeoMode = allowedModes.includes(String(geoMode)) ? String(geoMode) : 'global';
  const sanitizedGeoAreas = Array.isArray(geoAreas)
    ? geoAreas.map(s => String(s).trim()).filter(Boolean)
    : [];

  // category by _id OR slug OR name => store canonical name
  let categoryName = category;
  {
    const ors = [
      { slug: slugify(String(category || '')) },
      { name: String(category || '') }
    ];
    if (category && mongoose.Types.ObjectId.isValid(String(category))) {
      ors.push({ _id: category });
    }
    const foundCat = await Category.findOne({ $or: ors }).lean();
    if (foundCat) categoryName = foundCat.name;
  }

  const rawTags = Array.isArray(incomingTags) ? incomingTags : [];
  const tagsByName = [];
  for (const t of rawTags) {
    const nameOrSlug = String(t).trim();
    if (!nameOrSlug) continue;
    const tagDoc = await Tag.findOne({ $or: [{ slug: slugify(nameOrSlug) }, { name: nameOrSlug }] }).lean();
    tagsByName.push(tagDoc ? tagDoc.name : nameOrSlug);
  }

  const slug = await uniqueSlugForTitle(title);

  // Auto-pick Cloudinary image if none provided
  let finalImagePublicId = imagePublicId;
  let finalImageUrl      = imageUrl;
  let finalOgImage       = ogImage;

  if (!finalImagePublicId && !finalImageUrl &&
      String(process.env.CLOUDINARY_AUTOPICK || "").toLowerCase() === "on") {
    const picked = await pickBestImageForArticle({
      title,
      tags: tagsByName,
      category: categoryName
    });
    if (picked) {
      finalImagePublicId = picked.publicId;
      finalImageUrl      = picked.imageUrl;
      finalOgImage       = picked.ogImage;
    }
  }

  const finalPublishAt =
    publishAt ? new Date(publishAt)
              : (normalizedStatus === 'published' ? new Date() : undefined);

  const baseDoc = {
    title, slug, summary, author, body,
    category: categoryName,
    tags: tagsByName,

    imageUrl:      finalImageUrl || imageUrl,
    imagePublicId: finalImagePublicId || imagePublicId,

    imageAlt: (imageAlt || title || ''),
    metaTitle: (metaTitle || '').slice(0, 80),
    metaDesc: (metaDesc || '').slice(0, 200),
    ogImage: (finalOgImage || ogImage || ''),

    readingTime: estimateReadingTime(body),

    status: normalizedStatus,
    publishAt: finalPublishAt,

    geoMode: sanitizedGeoMode,
    geoAreas: sanitizedGeoAreas
  };

  await ensureArticleHasImage(baseDoc);

  if (normalizedStatus === 'published') {
    baseDoc.publishedAt = new Date();
  } else {
    baseDoc.publishedAt = undefined;
  }

  const doc = await Article.create(baseDoc);
  markSitemapDirty();
  res.status(201).json({ ...doc.toObject(), id: doc._id });
});

// Bulk create articles
// POST /api/articles/bulk?dryRun=1&continueOnError=1
app.post('/api/articles/bulk', auth, async (req, res) => {
  const isDry = String(req.query.dryRun || '').match(/^(1|true)$/i);
  const allowPartial = String(req.query.continueOnError || '').match(/^(1|true)$/i);

  let items;
  try {
    items = parseBulkBody(req.body);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid bulk payload: ' + e.message });
  }
  if (!items || !items.length) {
    return res.status(400).json({ ok: false, error: 'No items' });
  }

  const session = await mongoose.startSession();
  const results = [];
  let committed = false;

  try {
    let useTx = false;
    if (!isDry) {
      try {
        await session.startTransaction();
        useTx = true;
      } catch (e) {
        console.warn('[bulk] transactions unavailable, continuing without TX:', e?.message || e);
      }
    }

    for (let index = 0; index < items.length; index++) {
      try {
        const payload = await normalizeIncomingArticle(items[index]);
        if (isDry) {
          results.push({ index, ok: true, dryRun: true, slug: payload.slug });
        } else {
          const created = await Article.create([payload], useTx ? { session } : {});
          results.push({ index, ok: true, id: created[0]._id, slug: created[0].slug });
        }
      } catch (err) {
        results.push({ index, ok: false, error: err.message || 'validation failed' });
        if (!allowPartial) throw err;
      }
    }

    if (useTx) {
      await session.commitTransaction();
      committed = true;
      markSitemapDirty();
    }

    const success = results.filter(r => r.ok).length;
    const failed  = results.length - success;

    return res.json({
      ok: true,
      dryRun: !!isDry,
      total: results.length,
      success,
      failed,
      results
    });
  } catch (e) {
    if (!committed && session.inTransaction && session.inTransaction()) {
      await session.abortTransaction();
    }
    return res.status(400).json({
      ok: false,
      message: e?.message || 'Bulk import failed',
      results
    });
  } finally {
    session.endSession();
  }
});

// update (allow slug changes + write a redirect)
app.patch('/api/articles/:id', auth, async (req, res) => {
  const {
    title, summary, author, body, category, imageUrl, imagePublicId,
    status, publishAt,
    geoMode, geoAreas,
    tags: incomingTags,
    imageAlt,
    metaTitle,
    metaDesc,
    ogImage,
    slug: newSlugRaw, // allow changing slug
  } = req.body || {};

  // Load existing first to compare slug
  let existing;
  try {
    existing = await Article.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
  } catch {
    return res.status(400).json({ error: 'Bad id' });
  }

  const update = {};
  if (title !== undefined) update.title = title;
  if (summary !== undefined) update.summary = summary;
  if (author !== undefined) update.author = author;

  if (body !== undefined) {
    update.body = body || '';
    update.readingTime = estimateReadingTime(update.body);
  }

  if (imageUrl !== undefined) update.imageUrl = imageUrl;
  if (imagePublicId !== undefined) update.imagePublicId = imagePublicId;
  if (status !== undefined) update.status = status;
  if (publishAt !== undefined) update.publishAt = new Date(publishAt);

  if (metaTitle !== undefined) update.metaTitle = String(metaTitle).slice(0, 80);
  if (metaDesc  !== undefined) update.metaDesc  = String(metaDesc).slice(0, 200);
  if (ogImage   !== undefined) update.ogImage   = String(ogImage || '');
  if (imageAlt  !== undefined) update.imageAlt  = String(imageAlt || title || '');

  if (geoMode !== undefined) {
    const allowedModes = ['global', 'include', 'exclude'];
    update.geoMode = allowedModes.includes(String(geoMode)) ? String(geoMode) : 'global';
  }
  if (geoAreas !== undefined) {
    update.geoAreas = Array.isArray(geoAreas)
      ? geoAreas.map(s => String(s).trim()).filter(Boolean)
      : [];
  }

  if (category !== undefined) {
    const ors = [
      { slug: slugify(String(category || '')) },
      { name: String(category || '') }
    ];
    if (category && mongoose.Types.ObjectId.isValid(String(category))) {
      ors.push({ _id: category });
    }
    const catDoc = await Category.findOne({ $or: ors }).lean();
    update.category = catDoc ? catDoc.name : String(category);
  }

  // Handle slug change
  if (newSlugRaw !== undefined) {
    const newSlug = slugify(newSlugRaw);
    if (!newSlug) return res.status(400).json({ error: 'Invalid slug' });
    if (newSlug !== existing.slug) {
      const exists = await Article.exists({ slug: newSlug, _id: { $ne: existing._id } });
      if (exists) return res.status(409).json({ error: 'Slug already in use' });
      const oldSlug = existing.slug;
      update.slug = newSlug;
      // Create redirect from old -> new
      await createRedirect('article', oldSlug, newSlug, 301);
    }
  }

  // If moving to published, ensure publishAt/publishedAt exist
  if (status !== undefined) {
    const s = String(status).toLowerCase();
    update.status = (s === 'published') ? 'published' : 'draft';
    if (s === 'published') {
      if (!update.publishAt && !existing.publishAt) {
        update.publishAt = new Date();
      }
      update.publishedAt = new Date();
    }
  }

  const doc = await Article.findByIdAndUpdate(req.params.id, update, { new: true });
  markSitemapDirty();
  res.json({ ...doc.toObject(), id: doc._id });
});

// delete
app.delete('/api/articles/:id', auth, async (req, res) => {
  try {
    const doc = await Article.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.imagePublicId) {
      try { await cloudinary.uploader.destroy(doc.imagePublicId); } catch (e) { console.warn('Cloudinary cleanup error:', e.message); }
    }
    markSitemapDirty();
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Bad id' });
  }
});

/* -------------------- Categories CRUD -------------------- */
app.post('/api/categories', auth, async (req, res) => {
  const { name, slug, description, type } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const s = await ensureUniqueCategorySlug(name, slug);
  const doc = await Category.create({ name, slug: s, description, type });
  markSitemapDirty();
  res.status(201).json(doc);
});

app.get('/api/categories', async (req, res) => {
  try {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    const list = await Category.find(filter).sort({ name: 1 }).lean();
    res.json(list);
  } catch (err) {
    console.error('GET /api/categories failed:', err);
    res.status(500).json({ message: 'Failed to load categories' });
  }
});


// Allow category slug changes + write a redirect + store previous slug
app.patch('/api/categories/:id', auth, async (req, res) => {
  const { name, slug, description, type } = req.body || {};
  let cat;
  try {
    cat = await Category.findById(req.params.id);
    if (!cat) return res.status(404).json({ error: 'not found' });
  } catch { return res.status(400).json({ error: 'bad id' }); }

  const update = {};
  if (type !== undefined) update.type = type;
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;

  if (slug !== undefined) {
    const desired = await ensureUniqueCategorySlug(name || cat.name, slug);
    if (desired !== cat.slug) {
      const old = cat.slug;
      update.slug = desired;
      update.previousSlugs = Array.from(new Set([...(cat.previousSlugs || []), old]));
      await createRedirect('category', old, desired, 301);
    }
  }

  const doc = await Category.findByIdAndUpdate(req.params.id, update, { new: true });
  markSitemapDirty();
  res.json(doc);
});

app.delete('/api/categories/:id', auth, async (req, res) => {
  const cat = await Category.findById(req.params.id);
  if (!cat) return res.status(404).json({ error: 'not found' });
  const inUse = await Article.countDocuments({ category: cat.name });
  if (inUse > 0) return res.status(409).json({ error: `category in use by ${inUse} articles` });
  await Category.deleteOne({ _id: cat._id });
  markSitemapDirty();
  res.json({ ok: true });
});

/* -------------------- Tags CRUD -------------------- */
app.post('/api/tags', auth, async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const s = await ensureUniqueTagSlug(name, slug);
  const doc = await Tag.create({ name, slug: s });
  res.status(201).json(doc);
});

app.get('/api/tags', async (_req, res) => {
  const list = await Tag.find().sort({ name: 1 }).lean();
  res.json(list);
});

app.patch('/api/tags/:id', auth, async (req, res) => {
  const { name, slug } = req.body || {};
  const update = {};
  if (name !== undefined) update.name = name;
  if (slug !== undefined) update.slug = await ensureUniqueTagSlug(name || undefined, slug);
  const doc = await Tag.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json(doc);
});

app.delete('/api/tags/:id', auth, async (req, res) => {
  const inUse = await Article.countDocuments({ tags: { $in: [req.params.id] } });
  // We store tag names on Article; to be safe, don't block delete here
  await Tag.deleteOne({ _id: req.params.id });
  res.json({ ok: true, inUse });
});

/* -------------------- Media endpoints -------------------- */
// Upload an image to Cloudinary using memory buffer
app.post('/api/media/upload', auth, uploadMemory.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const folder = CLOUDINARY_FOLDER || 'news-site';
    const publicIdBase = (req.body?.publicIdBase || path.parse(req.file.originalname).name)
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'upload';

    const uploadOptions = {
      folder,
      public_id: `${publicIdBase}-${Date.now()}`,
      resource_type: 'image',
      overwrite: false
    };

    // Convert buffer to stream for Cloudinary uploader
    const pass = stream.PassThrough();
    pass.end(req.file.buffer);

    const uploaded = await new Promise((resolve, reject) => {
      const cloudStream = cloudinary.uploader.upload_stream(uploadOptions, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
      pass.pipe(cloudStream);
    });

    const saved = await upsertMediaFromCloudinaryResource(uploaded, 'admin');
    const variants = buildImageVariants(saved.publicId);

    res.status(201).json({ ...saved.toObject(), variants });
  } catch (e) {
    console.error('media upload failed:', e.message);
    res.status(500).json({ error: 'upload failed' });
  }
});

// List media (paginated)
app.get('/api/media', auth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
  const total = await Media.countDocuments();
  const items = await Media.find().sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean();
  res.json({ items, page, pageSize: limit, total, totalPages: Math.ceil(total/limit) });
});

// Delete media
app.delete('/api/media/:id', auth, async (req, res) => {
  const doc = await Media.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  try {
    await cloudinary.uploader.destroy(doc.publicId);
  } catch (e) {
    console.warn('Cloudinary destroy warn:', e?.message);
  }
  await Media.deleteOne({ _id: doc._id });
  res.json({ ok: true });
});

/* -------------------- Sitemap + sections v2 (optional) -------------------- */
app.use('/api/sections-v2', cacheRoute(60_000), sectionsV2);

/* -------------------- Fallbacks & diagnostics -------------------- */


// --- Compatibility route for old frontend: category by slug -> articles (robust match + sort) ---
// --- Compatibility route for old frontend: category by slug -> articles (robust type-guarded match) ---


// --- Category lookup by slug (used by CategoryPage.jsx) ---
app.get('/api/categories/slug/:slug', async (req, res) => {
  try {
    const raw = String(req.params.slug || '').trim();
    if (!raw) return res.status(400).json({ error: 'Missing slug' });

    // 1) Find category by slug or name (case-insensitive)
    const cat = await Category.findOne({
      $or: [
        { slug: raw.toLowerCase() },
        { name: new RegExp(`^${raw}$`, 'i') }
      ]
    }).lean();

    if (!cat) return res.status(404).json({ error: 'Category not found' });

    // 2) If incoming path uses name (or wrong case), 308 redirect to canonical slug
    

    // 3) Return minimal meta for the page
    res.json({
      id: String(cat._id),
      name: cat.name,
      slug: cat.slug,
      description: cat.description || '',
      type: cat.type || 'topic'
    });
  } catch (e) {
    console.error('GET /api/categories/slug/:slug failed', e);
    res.status(500).json({ error: 'Server error' });
  }
});


// --- Public articles for a category (used by CategoryPage.jsx & FinanceCategoryPage.jsx) ---
app.get('/api/public/categories/:slug/articles', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').trim();
    const page  = Math.max(parseInt(req.query.page  || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);
    const skip  = (page - 1) * limit;

    // 1) Resolve category by slug OR name (case-insensitive)
    const cat = await Category.findOne({
      $or: [
        { slug: new RegExp(`^${escapeRegex(slug)}$`, 'i') },
        { name: new RegExp(`^${escapeRegex(slug)}$`, 'i') }
      ]
    }).lean();

    if (!cat) return res.json({ items: [], total: 0, page, limit });

    const lcSlug   = String(cat.slug || '').toLowerCase();
    const lcName   = String(cat.name || '').toLowerCase();
    const catIdStr = String(cat._id || '');
    const catObjId = Types.ObjectId.isValid(catIdStr) ? new Types.ObjectId(catIdStr) : null;

    // 2) Robust match: slug/name (strings), stringified ObjectId, and true ObjectId
   // 2) Robust match: trims/lowercases strings, supports object {name,slug},
// arrays of strings/objects, and id-as-string / real ObjectId.
const wantSlug = lcSlug;
const wantName = lcName;

const matchStage = {
  status: 'published',
  $or: [
    // ---- category as STRING (normalize) ----
    {
      $expr: {
        $eq: [
          { $toLower: { $trim: { input: { $cond: [
            { $eq: [ { $type: "$category" }, "string" ] }, "$category", ""
          ] } } } },
          wantSlug
        ]
      }
    },
    {
      $expr: {
        $eq: [
          { $toLower: { $trim: { input: { $cond: [
            { $eq: [ { $type: "$category" }, "string" ] }, "$category", ""
          ] } } } },
          wantName
        ]
      }
    },

    // ---- category as OBJECT { name?, slug? } ----
    {
      $expr: {
        $eq: [
          { $toLower: { $trim: { input: { $ifNull: [ "$category.slug", "" ] } } } },
          wantSlug
        ]
      }
    },
    {
      $expr: {
        $eq: [
          { $toLower: { $trim: { input: { $ifNull: [ "$category.name", "" ] } } } },
          wantName
        ]
      }
    },

    // ---- categories[] as ARRAY OF STRINGS (normalize each) ----
    {
      $expr: {
        $in: [
          wantSlug,
          {
            $map: {
              input: { $ifNull: [ "$categories", [] ] },
              as: "c",
              in: { $toLower: { $trim: { input: "$$c" } } }
            }
          }
        ]
      }
    },
    {
      $expr: {
        $in: [
          wantName,
          {
            $map: {
              input: { $ifNull: [ "$categories", [] ] },
              as: "c",
              in: { $toLower: { $trim: { input: "$$c" } } }
            }
          }
        ]
      }
    },

    // ---- categories[] as ARRAY OF OBJECTS { name?, slug? } ----
    {
      $expr: {
        $in: [
          wantSlug,
          {
            $map: {
              input: { $ifNull: [ "$categories", [] ] },
              as: "c",
              in: { $toLower: { $trim: { input: { $ifNull: [ "$$c.slug", "" ] } } } }
            }
          }
        ]
      }
    },
    {
      $expr: {
        $in: [
          wantName,
          {
            $map: {
              input: { $ifNull: [ "$categories", [] ] },
              as: "c",
              in: { $toLower: { $trim: { input: { $ifNull: [ "$$c.name", "" ] } } } }
            }
          }
        ]
      }
    },

    // ---- exact matches for id-as-string and real ObjectId ----
    { category: catIdStr },
    { categories: catIdStr },
    ...(Types.ObjectId.isValid(catIdStr) ? [
      { category: new Types.ObjectId(catIdStr) },
      { categories: new Types.ObjectId(catIdStr) },
    ] : [])
  ]
};


    // 3) Sort newest-first by publishedAt, then createdAt, then _id
    const [items, totalAgg] = await Promise.all([
      Article.aggregate([
        { $match: matchStage },
        { $sort: { publishedAt: -1, createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            title: 1,
            slug: 1,
            summary: 1,
            imageUrl: 1,
            category: 1,
            categories: 1,
            publishedAt: 1,
            createdAt: 1
          }
        }
      ]),
      Article.aggregate([
        { $match: matchStage },
        { $count: 'n' }
      ])
    ]);

    const total = totalAgg?.[0]?.n || 0;

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    return res.json({
      category: { id: String(cat._id), name: cat.name, slug: cat.slug, description: cat.description || '' },
      items,
      total,
      page,
      limit
    });
  } catch (e) {
    return next(e);
  }
});

app.get('/api/_debug/endpoints', (_req, res) => {
  res.json(listEndpoints(app));
});

// 404 for /api/* (keep SPA routes to front-end)
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// Generic error handler (last)
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/* -------------------- Server bootstrap -------------------- */
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`✅ API up on http://${HOST}:${PORT}`);
  });
}

// Export app for testing
module.exports = app;
