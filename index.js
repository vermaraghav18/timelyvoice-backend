// backend/index.js — top of file

// 1) Load env FIRST
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// 2) Polyfill fetch for Node < 18
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// 3) Single configured Cloudinary instance
const cloudinary = require('./src/lib/cloudinary');

// 4) Core deps
const slugify = require('slugify');
const express = require('express');
const compression = require('compression');
const jwt = require('jsonwebtoken');

const rateLimit = require('express-rate-limit');
const cors = require('cors');          // ✅ keep only this one
const mongoose = require('mongoose');

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


// 6) Models registered early
const Article = require('./src/models/Article');
const cookieParser = require("cookie-parser");

const XSource = require('./src/models/XSource');  // <-- ADD
const XItem   = require('./src/models/XItem');    // <-- ADD

// 7) Cron jobs
require('./cron');

// 8) Upload utils
const multer = require('multer');
const stream = require('stream');

// 9) App init
const app = express();
app.use(cookieParser());




// --- Admin auth guard for protected routes (JWT, role=admin) ---
function auth(req, res, next) {
  const { JWT_SECRET } = process.env;

  let token = null;
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) token = h.slice(7);
  if (!token && req.cookies) token = req.cookies.token || null;

  try {
    const payload = jwt.verify(token || "", JWT_SECRET);
    if (!payload || payload.role !== "admin") throw new Error("bad");
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}


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

    // normalize and check
    const ok =
      allowedOrigins.includes(origin) ||
      /^http:\/\/localhost:5173$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:5173$/.test(origin);

    if (ok) return cb(null, true);

    console.warn('[CORS] blocked origin:', origin, 'allowed:', allowedOrigins);
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

// === Canonical URL normalizer (301 redirects) ===
// Only for GET/HEAD. Skip API/SSR/assets/robots/sitemap/etc.
// In dev, you can disable this entirely by gating on NODE_ENV.
app.use((req, res, next) => {
  try {
    // Only normalize real page navigations
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const p = req.path || '';
    // Never touch API or non-page paths
    const skip =
      p.startsWith('/api/') ||
      p.startsWith('/ssr/') ||
      p.startsWith('/rss') ||
      p.startsWith('/assets') ||
      p === '/robots.txt' ||
      p.startsWith('/sitemap');
    if (skip) return next();

    const host  = req.get('host');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
    const u = new URL(`${proto}://${host}${req.originalUrl}`);

    const beforePath   = u.pathname;
    const beforeSearch = u.search; // includes leading "?" when present

    // 1) strip tracking params
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid']
      .forEach(k => u.searchParams.delete(k));

    // 2) normalize path:
    //    - no trailing slash (except root)
    //    - lower-case slug for /category|/tag|/author/:slug
    let newPath = beforePath;
    if (newPath !== '/' && newPath.endsWith('/')) newPath = newPath.replace(/\/+$/, '');
    newPath = newPath.replace(
      /^\/(category|tag|author)\/([^\/]+)(.*)$/,
      (_m, seg, slug, rest) => `/${seg}/${slug.toLowerCase()}${rest || ''}`
    );

    // Rebuild search from params
    const searchStr = u.searchParams.toString();
    const newSearch = searchStr ? `?${searchStr}` : '';

    const changed = (newPath !== beforePath) || (newSearch !== beforeSearch);

    if (changed) {
      u.pathname = newPath;
      u.search   = newSearch;
      // redirect to path+query only (same host)
      return res.redirect(301, u.pathname + u.search);
    }
    return next();
  } catch {
    return next();
  }
});

// ===============================================


// Strong ETags let browsers/CDNs validate cached JSON quickly
app.set('etag', 'strong');
// Cache public GET endpoints so repeat visits are instant
app.use((req, res, next) => {
  // Only cache safe GET requests
  if (req.method !== 'GET') return next();

  // Do NOT cache anything under admin/auth/uploads/etc.
  const noCachePrefixes = [
    '/api/admin',
    '/api/auth',
    '/api/upload',
    '/api/media/upload',
  ];
  if (noCachePrefixes.some(p => req.path.startsWith(p))) {
    // Explicitly prevent caching for these
    res.set('Cache-Control', 'no-store');
    return next();
  }

   // ✅ Apply caching to ALL other /api/* GETs
  const isApi = req.path.startsWith('/api/');
  if (isApi) {
    // Default for lists/sections
    let header = 'public, max-age=60, s-maxage=300, stale-while-revalidate=30';

    // Slightly longer for single-article reads
    const isSingleArticle =
      /^\/api\/(public\/articles\/|articles\/)/.test(req.path) && !req.query.q;

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

 const xAutoRoutes = require("./src/automation/x/x.routes");
app.use("/api/automation/x", xAutoRoutes); 



app.get("/api/automation/_debug/openrouter", (req, res) => {
  res.json({
    keyPresent: !!process.env.OPENROUTER_API_KEY,
    keyPrefix: process.env.OPENROUTER_API_KEY?.slice(0, 10) || null,
    cwd: process.cwd(),
    envFileExpectedAt: require("path").resolve(__dirname, ".env")
  });
});

// [ADMIN_ARTICLES_ROUTE_IMPORT] Add this near other route imports
const adminArticlesRouter = require('./src/routes/admin.articles.routes');



// [ADMIN_ARTICLES_ROUTE_MOUNT] Add this near other app.use(...) mounts
app.use('/api/admin/articles', adminArticlesRouter);


app.use("/", robotsRoute);
// Cached versions of high-traffic endpoints
app.use('/api/breaking',  cacheRoute(30_000), breakingRoutes);
app.use('/api/ticker',    cacheRoute(30_000), tickerRoutes);
app.use('/api/sections',  cacheRoute(60_000), sectionsRouter);
app.use('/api/top-news',  cacheRoute(30_000), require("./src/routes/topnews"));



app.use('/api/plan-image', planImageRoutes);


function clearCache(prefix = '') {
  for (const key of cache.keys()) {
    if (!prefix || key.startsWith(prefix)) cache.delete(key);
  }
}


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

  if (!isBot(req)) return next(); // humans → SPA

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
  // Accept even if body is empty
  res.status(204).end();
});


/* -------------------- ENV -------------------- */
const {
  ADMIN_PASSWORD, JWT_SECRET, MONGO_URI,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_FOLDER = 'news-site',
  PUBLICATION_NAME = 'My News'
} = process.env;

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

/* -------------------- Models -------------------- */

/* -------------------- Models -------------------- */
// A) Redirects model + helpers (new)
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
// B) Track previous slugs for Category (schema change)
const catSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 50 },
  slug: { type: String, required: true, trim: true, unique: true, index: true },
  description: { type: String, maxlength: 200 },
  type: { type: String, enum: ['topic','state','city'], default: 'topic', index: true }, // <— add this
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

// Comments
const Comment = require('./models/Comment');
const Subscriber = require('./models/Subscriber');


// ⬇️ INSERT THESE TWO LINES HERE
setSitemapModels({ Article, Category, Tag });
app.use(sitemapRouter);


/* -------------------- MEDIA helpers -------------------- */
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
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

/* -------------------- Auth helpers -------------------- */
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

  // Basic password policy check for the configured admin password.
  // (Does not block login—just warns in logs if weak.)
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


// ===== Bulk import helpers =====

// Parse JSON array OR JSONL (one JSON per line) OR { items: [...] }
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

// Normalize one incoming article to your DB shape (reuses your existing logic)
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

  // category by slug or name → store name
  let categoryName = category;
  const foundCat = await Category.findOne({
    $or: [{ slug: slugify(category) }, { name: category }]
  }).lean();
  if (foundCat) categoryName = foundCat.name;

  // tags by slug or name → store names
  const rawTags = Array.isArray(incomingTags) ? incomingTags : [];
  const tagsByName = [];
  for (const t of rawTags) {
    const nameOrSlug = String(t).trim();
    if (!nameOrSlug) continue;
    const tagDoc = await Tag.findOne({ $or: [{ slug: slugify(nameOrSlug) }, { name: nameOrSlug }] }).lean();
    tagsByName.push(tagDoc ? tagDoc.name : nameOrSlug);
  }

  // unique slug (uses your helper)
  const slug = await uniqueSlugForTitle(title);

  /* >>> ADD THIS: try Cloudinary autopick if no image provided <<< */
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

  // ✅ Apply autopick results when available
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


   // 🔽 add this line
  await ensureArticleHasImage(doc);

  return doc;
}


/* -------------------- Auto image match (Cloudinary) -------------------- */

/**
 * Minimal stop-words so titles like "PM Modi addresses the nation" become useful keywords.
 */
const STOP_WORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','at','by','with','is','are','was','were','be',
  'as','from','that','this','these','those','it','its','into','over','after','before','about','than',
  'new'
]);

/**
 * Build keywords from title + tags + category (lowercased, no short words, no stop words).
 */
function buildArticleKeywords({ title = '', tags = [], category = '' }) {
  const raw = [
    String(title || ''),
    String(category || ''),
    ...(Array.isArray(tags) ? tags : [])
  ].join(' ');
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length >= 3 && !STOP_WORDS.has(w));
  // de-dup while keeping order
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  // keep first 8–12 is enough signal
  return out.slice(0, 12);
}

/**
 * Query Cloudinary Search for images in your folder that match any of the keywords
 * in tags OR in public_id/filename.
 */
async function searchCloudinaryByKeywords(keywords = []) {
  if (!keywords.length) return [];
  const folder = process.env.CLOUDINARY_FOLDER || 'news-images';

  // Build a search expression like:
  //  folder=news-images AND resource_type:image AND (tags=modi OR public_id:modi OR filename=modi OR ...)
  const ors = keywords.map(k => `(tags=${k} OR public_id:${k} OR filename:${k})`);
  const expr = `folder=${folder} AND resource_type:image AND (${ors.join(' OR ')})`;

  // Cloudinary Search API
  const max = parseInt(process.env.CLOUDINARY_AUTOPICK_MAX || '40', 10);
  const res = await cloudinary.search
    .expression(expr)
    .sort_by('uploaded_at','desc')
    .with_field('tags')
    .max_results(Math.min(100, Math.max(10, max)))
    .execute();

  return Array.isArray(res?.resources) ? res.resources : [];
}

/**
 * Score an image for our keywords (simple overlap + a small bonus for larger width).
 */
function scoreImage(resource, keywordsSet) {
  const id = String(resource.public_id || '').toLowerCase();
  const filename = id.split('/').pop(); // last segment
  const tags = (resource.tags || []).map(t => String(t).toLowerCase());
  let score = 0;

  for (const k of keywordsSet) {
    if (tags.includes(k)) score += 5;                 // strong tag hit
    if (id.includes(k)) score += 3;                   // id/public_id hit
    if (filename.includes(k)) score += 3;             // filename hit
  }
  // prefer decent images
  if (resource.width >= 1000) score += 2;
  if (resource.width >= 1600) score += 1;

  return score;
}

/**
 * Pick the single best Cloudinary image for an article.
 * Returns { imageUrl, imagePublicId, ogImage } or null.
 */
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

    // Build nice variants
    const publicId = best.public_id;
    const imageUrl = best.secure_url || cloudinary.url(publicId, { secure: true });
    const ogImage  = cloudinary.url(publicId, { width: 1200, height: 630, crop: 'fill', format: 'jpg', secure: true });

    return { imageUrl, imagePublicId: publicId, ogImage };
  } catch (e) {
    console.warn('[autopick-image] failed:', e?.message || e);
    return null;
  }
}

/**
 * If the payload has no image, try to attach one from Cloudinary based on keywords.
 * Mutates and returns the same object.
 */
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


/* -------------------- Articles API -------------------- */
// list
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

  const enforceGeo = !isAdmin;
  const geo = req.geo || {};
  const visibleItems = enforceGeo
    ? items.filter(a => isAllowedForGeoDoc(a, geo)
)
    : items;

  const mapped = visibleItems.map(a => ({ ...a, id: a._id, publishedAt: a.publishedAt }));

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

// alias search
app.get('/api/articles/search', optionalAuth, async (req, res) => {
  const page  = Math.max(parseInt(req.query.page  || '1', 10), 1);
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

  const enforceGeo = !isAdmin;
  const geo = req.geo || {};
  const visibleItems = enforceGeo
    ? items.filter(a => isAllowedForGeoDoc(a, geo)
)
    : items;

  const mapped = visibleItems.map(a => ({ ...a, id: a._id, publishedAt: a.publishedAt }));

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

// E) read by slug with redirects (public rules; admin token can see drafts)
app.get('/api/articles/slug/:slug', optionalAuth, async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const filter = { slug: req.params.slug };

  if (!isAdmin) {
    filter.status = 'published';
    const now = new Date();
    // If publishAt exists it must be <= now, OR if publishedAt exists it must be <= now,
    // OR if neither exists, let it pass (older records).
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

  let categoryName = category;
  const foundCat = await Category.findOne({ $or: [{ slug: slugify(category) }, { name: category }] }).lean();
  if (foundCat) categoryName = foundCat.name;

  const rawTags = Array.isArray(incomingTags) ? incomingTags : [];
  const tagsByName = [];
  for (const t of rawTags) {
    const nameOrSlug = String(t).trim();
    if (!nameOrSlug) continue;
    const tagDoc = await Tag.findOne({ $or: [{ slug: slugify(nameOrSlug) }, { name: nameOrSlug }] }).lean();
    tagsByName.push(tagDoc ? tagDoc.name : nameOrSlug);
  }

  const slug = await uniqueSlugForTitle(title);

    /* >>> ADD THIS: try Cloudinary autopick if no image provided <<< */
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



// 🔽 add this
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

// ===== Bulk create articles =====
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
          // Only report the slug we plan to create
          results.push({ index, ok: true, dryRun: true, slug: payload.slug });
        } else {
          const created = await Article.create([payload], useTx ? { session } : {});
          results.push({ index, ok: true, id: created[0]._id, slug: created[0].slug });
        }
      } catch (err) {
        results.push({ index, ok: false, error: err.message || 'validation failed' });
        if (!allowPartial) {
          // Abort entire run on first error unless continueOnError=1
          throw err;
        }
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

// C) update (allow slug changes + write a redirect)
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
    slug: newSlugRaw, // NEW: allow changing slug
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
    const catDoc = await Category.findOne({ $or: [{ slug: slugify(category) }, { name: category }] }).lean();
    update.category = catDoc ? catDoc.name : String(category);
  }

  if (incomingTags !== undefined) {
    const rawTags = Array.isArray(incomingTags) ? incomingTags : [];
    const tagsByName = [];
    for (const t of rawTags) {
      const nameOrSlug = String(t).trim();
      if (!nameOrSlug) continue;
      const tagDoc = await Tag.findOne({ $or: [{ slug: slugify(nameOrSlug) }, { name: nameOrSlug }] }).lean();
      tagsByName.push(tagDoc ? tagDoc.name : nameOrSlug);
    }
    update.tags = tagsByName;
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
    // ✅ invalidate sitemap cache (slug/status/publishAt/category/tag changes can affect URLs or listings)
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

     // ✅ invalidate sitemap cache (article URL removed)
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


   // ✅ invalidate sitemap cache (new /category/:slug)
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


// Get single category by slug
// Get single category by slug (case-insensitive + name fallback)
app.get('/api/categories/slug/:slug', async (req, res) => {
  const raw = String(req.params.slug || '').trim();
  const normalized = slugify(raw); // e.g., "Health" -> "health"

  const cat = await Category.findOne({
    $or: [
      { slug: raw },        // exact match (if frontend already passes slug)
      { slug: normalized }, // normalized slug (handles case/mixed input)
      { name: raw }         // fallback: category name
    ]
  }).lean();

  if (!cat) return res.status(404).json({ error: 'not found' });
  res.json(cat);
});


// D) Allow category slug changes + write a redirect + store previous slug
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

  // ✅ invalidate sitemap cache (category URL or name affects /category and listings)
  markSitemapDirty();

  res.json(doc);
});
app.delete('/api/categories/:id', auth, async (req, res) => {
  const cat = await Category.findById(req.params.id);
  if (!cat) return res.status(404).json({ error: 'not found' });
  const inUse = await Article.countDocuments({ category: cat.name });
  if (inUse > 0) return res.status(409).json({ error: `category in use by ${inUse} articles` });
  await Category.deleteOne({ _id: cat._id });

   // ✅ invalidate sitemap cache (category URL removed)
  markSitemapDirty();

  res.json({ ok: true });
});

/* -------------------- Tags CRUD -------------------- */
app.post('/api/tags', auth, async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const s = await ensureUniqueTagSlug(name, slug);
  const doc = await Tag.create({ name, slug: s });

  // ✅ invalidate sitemap cache (new /tag/:slug)
  markSitemapDirty();

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
  if (slug !== undefined) update.slug = await ensureUniqueTagSlug(name || '', slug);
  try {
    const doc = await Tag.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ error: 'not found' });

     // ✅ invalidate sitemap cache (tag slug change affects /tag/:slug)
  markSitemapDirty();

    res.json(doc);
  } catch { res.status(400).json({ error: 'bad id' }); }
});
app.delete('/api/tags/:id', auth, async (req, res) => {
  const tag = await Tag.findById(req.params.id);
  if (!tag) return res.status(404).json({ error: 'not found' });
  await Tag.deleteOne({ _id: tag._id });

  // ✅ invalidate sitemap cache (tag URL removed)
  markSitemapDirty();

  res.json({ ok: true });
});

/* -------------------- Public browse by category/tag -------------------- */
// E) Category API honors redirects
app.get('/api/public/categories/:slug/articles', async (req, res) => {
  let cat = await Category.findOne({ slug: req.params.slug }).lean();
  if (!cat) {
    const r = await resolveRedirect('category', req.params.slug);
    if (r) {
      bumpRedirectHit(r._id);
      res.setHeader('Location', `/api/public/categories/${encodeURIComponent(r.to)}/articles`);
      return res.status(308).json({ redirectTo: `/category/${r.to}` });
    }
    return res.status(404).json({ error: 'category not found' });
  }
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);

  const base = { status: 'published', publishAt: { $lte: new Date() }, category: cat.name };
  const total = await Article.countDocuments(base);
  const items = await Article.find(base).sort({ publishedAt: -1 }).skip((page - 1) * limit).limit(limit).lean();

  const geo = req.geo || {};
  const visible = items.filter(a => isAllowedForGeoDoc(a, geo)
);

  res.json({ category: { name: cat.name, slug: cat.slug }, items: visible, page, pageSize: limit, total, totalPages: Math.ceil(total / limit) });
});

app.get('/api/public/tags/:slug/articles', async (req, res) => {
  const tag = await Tag.findOne({ slug: req.params.slug }).lean();
  if (!tag) return res.status(404).json({ error: 'tag not found' });
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 50);

  const base = { status: 'published', publishAt: { $lte: new Date() }, tags: tag.name };
  const total = await Article.countDocuments(base);
  const items = await Article.find(base).sort({ publishedAt: -1 }).skip((page - 1) * limit).limit(limit).lean();

  const geo = req.geo || {};
  const visible = items.filter(a => isAllowedForGeoDoc(a, geo)
);

  res.json({ tag: { name: tag.name, slug: tag.slug }, items: visible, page, pageSize: limit, total, totalPages: Math.ceil(total / limit) });
});

/* -------------------- MEDIA endpoints -------------------- */
app.get('/api/media', auth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 50);
  const q = (req.query.q || '').trim();

  const filter = {};
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ publicId: rx }, { url: rx }];
  }

  const total = await Media.countDocuments(filter);
  const items = await Media.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.json({
    items,
    page,
    pageSize: limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total
  });
});

app.post('/api/media/upload', auth, uploadMemory.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: process.env.CLOUDINARY_FOLDER || 'news-site',
        resource_type: 'image',
        overwrite: false,
      },
      async (err, result) => {
        if (err) {
          console.error('cloudinary upload error:', err);
          return res.status(500).json({ error: 'upload failed' });
        }
        const saved = await upsertMediaFromCloudinaryResource(result, 'admin');
const { thumbUrl, ogUrl } = buildImageVariants(result.public_id);
res.status(201).json({ ...saved.toObject?.() ?? saved, thumbUrl, ogUrl });

      }
    );

    bufferToStream(req.file.buffer).pipe(uploadStream);
  } catch (e) {
    console.error('media upload error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/media/remote', auth, async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'valid https url required' });
    }
    const result = await cloudinary.uploader.upload(url, {
      folder: process.env.CLOUDINARY_FOLDER || 'news-site',
      resource_type: 'image',
      overwrite: false,
    });
    const saved = await upsertMediaFromCloudinaryResource(result, 'admin');
const { thumbUrl, ogUrl } = buildImageVariants(result.public_id);
res.status(201).json({ ...saved.toObject?.() ?? saved, thumbUrl, ogUrl });


  } catch (e) {
    console.error('media remote error:', e);
    res.status(500).json({ error: 'upload failed' });
  }
});

app.post('/api/media/ingest', auth, async (req, res) => {
  try {
    const { publicId } = req.body || {};
    if (!publicId) return res.status(400).json({ error: 'publicId required' });

    const info = await cloudinary.api.resource(publicId, { resource_type: 'image' });
    const saved = await upsertMediaFromCloudinaryResource(info, 'admin');
const { thumbUrl, ogUrl } = buildImageVariants(info.public_id);
res.status(201).json({ ...saved.toObject?.() ?? saved, thumbUrl, ogUrl });

  } catch (e) {
    console.error('media ingest error:', e);
    res.status(404).json({ error: 'cloudinary asset not found' });
  }
});

app.delete('/api/media/:id', auth, async (req, res) => {
  try {
    const doc = await Media.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });

    try { await cloudinary.uploader.destroy(doc.publicId, { resource_type: 'image' }); }
    catch (e) { console.warn('cloudinary destroy warn:', e?.message); }

    await Media.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'bad id' });
  }
});

/* -------------------- DEV: Seed & Export -------------------- */
// DEV SEED (admin only) — creates core categories if missing + a couple demo articles
app.post('/api/dev/seed', auth, async (req, res) => {
  try {
    // idempotent categories
    const cats = [
      { name: 'General', slug: 'general' },
      { name: 'World', slug: 'world-news-2', description: 'Global news' },
      { name: 'Tech', slug: 'tech' },
      { name: 'Sports', slug: 'sports' },
    ];
    for (const c of cats) {
      await Category.findOneAndUpdate({ slug: c.slug }, c, { upsert: true, new: true });
    }

    // add a few demo articles if the DB is nearly empty
    const count = await Article.countDocuments();
    if (count < 5) {
      const now = new Date();
      await Article.insertMany([
        {
          title: 'Hello CMS',
          slug: 'hello-cms',
          summary: 'First demo post.',
          author: 'Admin',
          body: 'Welcome to your news site!',
          category: 'General',
          status: 'published',
          readingTime: 1,
          publishedAt: now,
        },
        {
          title: 'Tech roundup',
          slug: 'tech-roundup',
          summary: 'Latest in technology.',
          author: 'Staff',
          body: 'Gadgets, AI, and more…',
          category: 'Tech',
          status: 'published',
          readingTime: 2,
          publishedAt: now,
        },
      ]);
    }

    markSitemapDirty();


    res.json({ ok: true });
  } catch (e) {
    console.error('seed failed', e);
    res.status(500).json({ error: 'seed failed' });
  }
});

// Export all articles as JSON (handy for backups/migration)
app.get('/api/export/articles', async (_req, res) => {
  const docs = await Article.find({}).sort({ publishedAt: -1 }).lean();
  res.setHeader('Content-Disposition', 'attachment; filename="articles.json"');
  res.json(docs);
});

/* -------------------- SEO helpers for feeds/SSR -------------------- */
const PORT = process.env.PORT || 4000;

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || 'https://timelyvoice.com';
const SITE_URL = FRONTEND_BASE_URL; // keep old name for rest of code
// Fallback image for RSS when an article has no image set
const SITE_LOGO = process.env.SITE_LOGO || `${SITE_URL.replace(/\/$/, '')}/logo-192.png`;

function xmlEscape(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
function stripHtml(s = '') { return String(s).replace(/<[^>]*>/g, ''); }
function buildDescription(doc) {
  const raw = (doc?.summary && doc.summary.trim())
    || stripHtml(doc?.body || '').slice(0, 200);
  return String(raw).replace(/\s+/g, ' ').slice(0, 160);
}

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
function htmlEscape(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}



/* -------------------- Existing SSR validator page -------------------- */
app.get('/article/:slug', async (req, res) => {
  try {

        const cacheKey = `ssr:validator:${req.params.slug}`;
    if (isBot(req)) {
      const cached = ssrCacheGet(cacheKey);
      if (cached) {
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        return res.type('html').send(cached);
      }
    }

    const slug = req.params.slug;

    const filter = { slug, status: 'published', publishAt: { $lte: new Date() } };
    let doc = await Article.findOne(filter).lean();

    // G) SSR honors redirects
    if (!doc) {
      const r = await resolveRedirect('article', slug);
      if (r) {
        bumpRedirectHit(r._id);
        return res.redirect(r.type || 301, `${SITE_URL}/article/${encodeURIComponent(r.to)}`);
      }
      return res.status(404).send('Not found');
    }

    const ua = String(req.headers['user-agent'] || '');
    const isTrustedBot = /Googlebot|AdsBot|bingbot|DuckDuckBot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot/i.test(ua);

   if (!isTrustedBot) {
    const allowed = isAllowedForGeoDoc(doc, req.geo || {});
    if (!allowed) return res.status(404).send('Not found');
  }

    const pageUrl = `${SITE_URL}/article/${encodeURIComponent(slug)}`;

   const title       = (doc.metaTitle && doc.metaTitle.trim()) || doc.title || 'Article';
const description = (doc.metaDesc  && doc.metaDesc.trim())  || buildDescription(doc);
const ogImage     = (doc.ogImage   && doc.ogImage.trim())   || doc.imageUrl || '';

    const published = doc.publishedAt || doc.publishAt || doc.createdAt || new Date();
    const modified = doc.updatedAt || published;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": title,
      "description": description,
      "image": ogImage ? [ogImage] : undefined,
      "datePublished": new Date(published).toISOString(),
      "dateModified": new Date(modified).toISOString(),
      "author": doc.author ? { "@type": "Person", "name": doc.author } : undefined,
      "mainEntityOfPage": { "@type": "WebPage", "@id": pageUrl }
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

    if (isBot(req)) ssrCacheSet(cacheKey, html);  // <--- add this
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.type('html').send(html);
  } catch (e) {
    console.error('SSR article error:', e); 
    res.status(500).send('server render failed');
  }
});

/* -------------------- Crawler-friendly SSR (NewsArticle) -------------------- */
function buildNewsArticleJSONLD(a, canonicalUrl, { title, description, image } = {}) {
  const SITE_LOGO = process.env.SITE_LOGO || "https://timelyvoice.com/logo.png";

  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": (title && String(title).trim()) || a.title,
    "description": description !== undefined ? String(description) : (a.summary || ""),
    "image": (image ? [image] : (a.ogImage ? [a.ogImage] : (a.imageUrl ? [a.imageUrl] : [SITE_LOGO]))),
    "datePublished": new Date(a.publishedAt || a.createdAt || Date.now()).toISOString(),
    "dateModified": new Date(a.updatedAt || a.publishedAt || a.createdAt || Date.now()).toISOString(),
    "author": a.author ? [{ "@type": "Person", "name": a.author }] : [{ "@type": "Organization", "name": "The Timely Voice" }],
    "publisher": {
      "@type": "Organization",
      "name": "The Timely Voice",
      "logo": { "@type": "ImageObject", "url": SITE_LOGO }
    },
    "articleSection": a.category || "General",
    "mainEntityOfPage": { "@type": "WebPage", "@id": canonicalUrl },
    "url": canonicalUrl
  };
}



app.get('/ssr/article/:slug', async (req, res) => {
  try {
    const cacheKey = `ssr:article:${req.params.slug}`;
    if (isBot(req)) {
      const cached = ssrCacheGet(cacheKey);
      if (cached) {
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
        return res.type('html').send(cached);
      }
    }

    const { slug } = req.params;
    const filter = { slug, status: 'published', publishAt: { $lte: new Date() } };
    const a = await Article.findOne(filter).lean();
    if (!a) {
      const r = await resolveRedirect('article', slug);
      if (r) {
        bumpRedirectHit(r._id);
        return res.redirect(r.type || 301, `${req.protocol}://${req.get('host')}/ssr/article/${encodeURIComponent(r.to)}`);
      }
      return res.status(404).send('Not found');
    }

    // ✅ NEW: trust bots and skip geo block for them
    const ua = String(req.headers['user-agent'] || '');
    const isTrustedBot = /Googlebot|AdsBot|bingbot|DuckDuckBot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot/i.test(ua);

    if (!isTrustedBot) {
      if (!isAllowedForGeoDoc(a, req.geo || {})) {
        return res.status(404).send('Not found');
      }
    }


    const canonicalUrl = `${FRONTEND_BASE_URL}/article/${encodeURIComponent(slug)}`;
    const selfUrl      = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    // Prefer editor-specified SEO fields; fall back to computed values
    const title = (a.metaTitle && a.metaTitle.trim()) || a.title || 'Article';
    const desc  = (a.metaDesc  && a.metaDesc.trim())  || buildDescription(a);
    const og    = (a.ogImage   && a.ogImage.trim())   || a.imageUrl || '';

   // ✅ Build JSON-LD with canonical frontend URL (not backend)
const jsonLd = buildNewsArticleJSONLD(a, canonicalUrl, {
  title,
  description: desc,
  image: og
});

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${htmlEscape(title)} – My News</title>

  <!-- Canonical to SPA -->
  <link rel="canonical" href="${htmlEscape(canonicalUrl)}"/>

  <!-- Basic SEO & social -->
  <meta name="description" content="${htmlEscape(desc)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="${htmlEscape(title)}"/>
  <meta property="og:description" content="${htmlEscape(desc)}"/>
  <meta property="og:url" content="${htmlEscape(canonicalUrl)}"/>   <!-- ✅ changed -->
  ${og ? `<meta property="og:image" content="${htmlEscape(og)}"/>` : ''}

  <meta name="twitter:card" content="${og ? 'summary_large_image' : 'summary'}"/>
  <meta name="twitter:title" content="${htmlEscape(title)}"/>
  <meta name="twitter:description" content="${htmlEscape(desc)}"/>
  ${og ? `<meta name="twitter:image" content="${htmlEscape(og)}"/>` : ''}

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
      <h1 style="margin-top:0">${htmlEscape(title)}</h1>
      <small class="muted">${new Date(a.publishedAt).toLocaleString()} • ${htmlEscape(a.author || '')} • ${htmlEscape(a.category || 'General')}</small>
      <hr/>
      <div style="line-height:1.7;white-space:pre-wrap">${htmlEscape(a.body || '')}</div>
    </article>
  </div>
</body>
</html>`;

    if (isBot(req)) ssrCacheSet(cacheKey, html);

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.set('Content-Type', 'text/html; charset=utf-8').status(200).send(html);

  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

/* -------------------- RSS & Sitemaps -------------------- */
// RSS 2.0 feed
// RSS 2.0 feed (rich)
// requires: SITE_URL, xmlEscape(), stripHtml(), buildDescription(), isAllowedForGeoDoc()
app.get('/rss.xml', async (req, res) => {
  try {
    const now = new Date(); // <-- INSERTED: define now

    const docs = await Article.find({
      status: 'published',
      $or: [
        { publishAt: { $lte: now } },
        { publishAt: { $exists: false } },
        { publishAt: null }
      ]
    })

      .sort({ publishedAt: -1 })
      .limit(100)
      .lean();

    const geo = req.geo || {};
    const items = docs.filter(d => isAllowedForGeoDoc(d, geo));

    const feedItems = items.map(a => {
  const slug = encodeURIComponent(a.slug);
  const link = `${SITE_URL}/article/${slug}`;
  const pubDate = new Date(a.publishedAt || a.createdAt || Date.now()).toUTCString();

  const title    = a.title || 'Article';
  const author   = (a.author && a.author.trim()) || 'Timely Voice Staff';
  const category = a.category || 'General';

  // Prefer article image; fallback to site logo (so media:content is always present)
  const image = (a.ogImage && a.ogImage.trim()) || (a.imageUrl && a.imageUrl.trim()) || SITE_LOGO;

  const summary =
    (a.summary && a.summary.trim()) ||
    buildDescription(a) ||
    '';

  const contentHtml = `
    ${image ? `<p><img src="${xmlEscape(image)}" alt="${xmlEscape(title)}" /></p>` : ''}
    ${summary ? `<p>${xmlEscape(summary)}</p>` : ''}
    <p><a href="${xmlEscape(link)}">Read more</a></p>
  `.trim();

  // Optional standard RSS <author>: expects "email (Name)". Use a generic email.
  const authorEmail = process.env.FEED_AUTHOR_EMAIL || 'noreply@timelyvoice.com';

  return `
    <item>
      <title>${xmlEscape(title)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="false">${xmlEscape(String(a._id))}</guid>
      <pubDate>${pubDate}</pubDate>

      <description><![CDATA[${summary}]]></description>
      <content:encoded><![CDATA[${contentHtml}]]></content:encoded>

      <dc:creator><![CDATA[${author}]]></dc:creator>
      <author>${xmlEscape(authorEmail)} (${xmlEscape(author)})</author>

      <category><![CDATA[${category}]]></category>
      <source url="${xmlEscape(SITE_URL)}"><![CDATA[Timely Voice]]></source>

      <media:content url="${xmlEscape(image)}" medium="image" />
      <media:thumbnail url="${xmlEscape(image)}" />
    </item>`;
}).join('');

   const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:atom="http://www.w3.org/2005/Atom"
>
  <channel>
    <title>${xmlEscape('Timely Voice')}</title>
    <link>${xmlEscape(SITE_URL)}</link>
    <atom:link rel="self" type="application/rss+xml" href="${xmlEscape(`${SITE_URL.replace(/\/$/, '')}/rss.xml`)}" />
    <description>${xmlEscape('Latest articles from Timely Voice')}</description>
    <language>en</language>
    ${feedItems}
  </channel>
</rss>`;

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.type('application/rss+xml; charset=utf-8').send(xml);
  } catch (e) {
    console.error('rss.xml error:', e);
    res.status(500).send('rss generation failed');
  }
});


app.get('/rss/:slug.xml', async (req, res) => {
  try {
     const slugAliases = { world: 'international', biz: 'business' };

const raw  = String(req.params.slug || '').trim().toLowerCase();
const slug = slugAliases[raw] || raw;
if (!slug) return res.status(400).send('missing category slug');


    // 1) Find category by slug
    const cat = await Category.findOne({ slug }).lean();
    if (!cat) {
      // Helpful error (readers prefer 404 over generic 500)
      return res.status(404).send(`unknown category: ${slug}`);
    }

    // 2) Fetch articles in this category, allow missing publishAt
const now = new Date();
const docs = await Article.find({
  status: 'published',
  category: cat.name, // <-- use Category NAME, not ObjectId field
  $or: [
    { publishAt: { $lte: now } },
    { publishAt: { $exists: false } },
    { publishAt: null },
  ],
})
  .sort({ publishedAt: -1, _id: -1 })
  .limit(100)
  .lean();


    // 3) Build RSS safely
    const siteUrl = SITE_URL.replace(/\/+$/, '');

    const feedTitle = `${cat.title || cat.name || slug} — Timely Voice`;
    const selfUrl = `${siteUrl}/rss/${encodeURIComponent(slug)}.xml`;

    let xml = '';
    xml += `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n`;
    xml += `<channel>\n`;
    xml += `<title>${escapeXml(feedTitle)}</title>\n`;
      xml += `<link>${siteUrl}</link>\n`;
      xml += `<description>${escapeXml(feedTitle)}</description>\n`;
      xml += `<atom:link href="${selfUrl}" rel="self" type="application/rss+xml"/>\n`;
      xml += `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n`;
      xml += `<language>en</language>\n`;

    for (const a of docs) {
  const title  = a.title || 'Untitled';
  const url    = `${siteUrl}/article/${a.slug}`;
  const pubISO = new Date(a.publishedAt || a.publishAt || a.updatedAt || Date.now()).toUTCString();

  // Robust image fallback
  const imgUrl =
    (a.ogImage && a.ogImage.trim()) ||
    (a.imageUrl && a.imageUrl.trim()) ||
    SITE_LOGO;

  // Clean, short description
  const summary = cleanSummary(a.summary || a.excerpt || '');

  // Optional rich body for readers that support content:encoded
  const contentHtml = `
    ${imgUrl ? `<p><img src="${escapeXml(imgUrl)}" alt="${escapeXml(title)}" /></p>` : ''}
    ${summary ? `<p>${escapeXml(summary)}</p>` : ''}
    <p><a href="${escapeXml(url)}">Read more</a></p>
  `.trim();

  xml += `  <item>\n`;
  xml += `    <title>${escapeXml(title)}</title>\n`;
  xml += `    <link>${escapeXml(url)}</link>\n`;               // escaped link ✅
  xml += `    <guid isPermaLink="true">${escapeXml(url)}</guid>\n`;
  xml += `    <pubDate>${pubISO}</pubDate>\n`;
  if (summary) xml += `    <description><![CDATA[${summary}]]></description>\n`;
  xml += `    <content:encoded><![CDATA[${contentHtml}]]></content:encoded>\n`;
  if (imgUrl) {
    xml += `    <media:content url="${escapeXml(imgUrl)}" medium="image" />\n`;
    xml += `    <media:thumbnail url="${escapeXml(imgUrl)}" />\n`;
  }
  xml += `    <source url="${escapeXml(siteUrl)}">Timely Voice</source>\n`;
  xml += `  </item>\n`;
}


    xml += `</channel>\n</rss>\n`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (err) {
    console.error('RSS(category) error:', err?.stack || err);
    return res.status(500).send('rss generation failed');
  }
});

// helper
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanSummary(str = '') {
  const s = String(str);
  // remove our internal markers or stray tokens
  return s
    .replace(/:contentReference\[.*?\]/g, '')
    .replace(/\[oaicite:.*?\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// --- Safe renderable image resolver (for old or missing Cloudinary links) ---
function ensureRenderableImage(a) {
  const FALLBACK =
    process.env.SITE_FALLBACK_IMG ||
    'https://res.cloudinary.com/damjdyqj2/image/upload/f_auto,q_auto,w_640/news-images/defaults/fallback-hero';

  // prefer explicit ogImage → cloudinary publicId → imageUrl → fallback
  if (a.ogImage && /^https?:\/\//i.test(a.ogImage)) return a.ogImage;

  if (a.imagePublicId) {
    const cloudinary = require('./src/lib/cloudinary');
    return cloudinary.url(a.imagePublicId, {
      width: 640,
      crop: 'fill',
      format: 'jpg',
      secure: true,
    });
  }

  if (a.imageUrl && /^https?:\/\//i.test(a.imageUrl)) return a.imageUrl;

  return FALLBACK;
}

// --- OpenRouter key sanity ping (returns model list on success) ---
app.get("/api/automation/_debug/openrouter/ping", async (req, res) => {
  try {
    const raw = process.env.OPENROUTER_API_KEY;
    const apiKey = (raw || "").trim();

    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.SITE_URL || "http://localhost",
        "X-Title": "TimelyVoice Admin",
      }
    });

    const body = await r.text();
    res.status(r.status).type("application/json").send(body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Surface server errors in JSON so the Admin can see the real cause ---
app.use((err, req, res, next) => {
  console.error("[SERVER ERROR]", err);
  const msg = (err && err.message) ? err.message : String(err);
  res.status(500).json({ error: msg, stack: err?.stack });
});

// Also catch unhandled async errors
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});



/* -------------------- Start server -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log('API listening on', PORT);
});
