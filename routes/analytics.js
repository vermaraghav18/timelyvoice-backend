// backend/routes/analytics.js
const router = require('express').Router();
const AnalyticsEvent = require('../models/AnalyticsEvent');

// --- rollup & daily models ---
const { rollupDaily } = require('../jobs/rollupDaily');
const AnalyticsDaily = require('../models/AnalyticsDaily');

/* ============================
   HELPERS
   ============================ */

// helper: YYYY-MM-DD in UTC
function utcDateString(d = Date.now()) {
  return new Date(d).toISOString().slice(0, 10);
}

/* ============================
   COLLECTOR
   ============================ */

// POST /analytics/collect
// POST /analytics/collect
router.post('/collect', async (req, res) => {
  try {
    const enabled = process.env.ANALYTICS_ENABLE !== 'false';
    if (!enabled) return res.status(204).end();

    const sampleRate = Number(process.env.ANALYTICS_SAMPLE_RATE || 1);
    if (sampleRate < 1 && Math.random() > sampleRate) return res.status(204).end();

    const body = req.body || {};
    if (!body.type) return res.status(400).json({ error: 'type required' });

    // Drop if excluded
    const flags = {
      isBot: !!req.isBot,
      isAdmin: !!req.isAdmin,
      dnt: !!req.isDnt,
      optOut: !!req.isOptOut,
      ...(body.flags || {}),
    };
    if (flags.isBot || flags.isAdmin || flags.dnt || flags.optOut) {
      return res.status(204).end();
    }

    // derive client IP (first in XFF) or socket
    const rawXff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = rawXff || req.socket?.remoteAddress || null;

    const g = req.geo || {};

    const doc = {
      type: body.type,
      ts: body.ts ? new Date(body.ts) : new Date(),
      visitorId: body.visitorId || null,
      sessionId: body.sessionId || null,
      path: body.path || null,
      utm: body.utm || null,
      referrer: body.referrer || null,
      scroll: body.scroll || null,
      read: body.read || null,

      // keep full objects
      geo: g,
      device: req.device || null,
      flags,

      // 🔴 NEW: flattened geo fields used by rollups
      ip,
      country: g.country || null,   // e.g. "US", "IN"
      region: g.region || null,     // provider region code
      city: g.city || null,
    };

    const saved = await AnalyticsEvent.create(doc);

    if (process.env.NODE_ENV !== 'production') {
      console.log('[analytics] saved', saved._id.toString(), doc.type, 'country=', doc.country || '(null)');
    }

    return res.status(204).end();
  } catch (err) {
    console.error('POST /analytics/collect insert error:', err);
    return res.status(500).json({ error: 'insert_failed', details: String(err?.message || err) });
  }
});

/* ============================
   HEALTH / DEBUG
   ============================ */

// GET /analytics/health
router.get('/health', async (req, res) => {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000); // 1 hour
    const lastHour = await AnalyticsEvent.countDocuments({
      createdAt: { $gte: since },
      'flags.isBot': { $ne: true },
      'flags.isAdmin': { $ne: true },
    });

    const totalApprox = await AnalyticsEvent.estimatedDocumentCount();

    res.json({
      ok: true,
      now: new Date().toISOString(),
      lastHour,
      totalApprox,
    });
  } catch (err) {
    console.error('GET /analytics/health error:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// TEMP: GET /analytics/debug/last3  (remove later)
router.get('/debug/last3', async (req, res) => {
  const docs = await AnalyticsEvent.find({}).sort({ createdAt: -1 }).limit(3).lean();
  res.json(docs);
});

/* ============================
   DAILY ROLLUP / READ
   ============================ */

// Run rollup for a date (YYYY-MM-DD, UTC). If omitted, rolls TODAY (UTC).
// GET /analytics/rollup/daily?date=YYYY-MM-DD
router.get('/rollup/daily', async (req, res) => {
  try {
    const requested = (req.query.date || '').trim();
    const date = requested || utcDateString(Date.now()); // default = TODAY
    const result = await rollupDaily(date);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('rollup daily error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================
   NEW: CSV must be BEFORE /daily/:date
   ============================ */

// CSV export for per-day per-path
// GET /analytics/daily/:date.csv
router.get('/daily/:date.csv', async (req, res) => {
  try {
    const date = String(req.params.date || '').trim();
    let doc = await AnalyticsDaily.findOne({ date }).lean();

    // If missing AND it's for today, auto-roll once then retry
    if (!doc && date === utcDateString()) {
      try {
        await rollupDaily(date);
        doc = await AnalyticsDaily.findOne({ date }).lean();
      } catch (e) {
        console.warn('auto-roll for CSV failed:', e);
      }
    }

    if (!doc) return res.status(404).send('not_found');

    const rows = [['path','events','page_view','scroll','heartbeat','read_complete','uniques','readSeconds']];
    for (const p of (doc.byPath || [])) {
      rows.push([
        p.path || '',
        p.events || 0,
        p.page_view || 0,
        p.scroll || 0,
        p.heartbeat || 0,
        p.read_complete || 0,
        p.uniques || 0,
        p.readSeconds || 0
      ]);
    }

    const csv = rows
      .map(r =>
        r
          .map(v => String(v).replace(/"/g, '""'))
          .map(v => /[",\n]/.test(v) ? `"${v}"` : v)
          .join(',')
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${date}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('GET /analytics/daily/:date.csv error:', e);
    res.status(500).send('error');
  }
});

/* ============================
   READ DAILY (with filters)
   ============================ */

// Read a daily document (with optional search/sort on per-path)
// GET /analytics/daily/:date?search=&sort=page_view&dir=desc
router.get('/daily/:date', async (req, res) => {
  const date = String(req.params.date || '').trim();
  const doc = await AnalyticsDaily.findOne({ date }).lean();
  if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });

  // Per-path filtering/sorting (optional)
  let byPath = Array.isArray(doc.byPath) ? [...doc.byPath] : [];
  const search = (req.query.search || '').toString().trim();
  if (search) {
    const s = search.toLowerCase();
    byPath = byPath.filter(p => (p.path || '').toLowerCase().includes(s));
  }

  const sortKey = (req.query.sort || '').toString() || 'page_view';
  const dir = (req.query.dir || 'desc').toString().toLowerCase() === 'asc' ? 1 : -1;
  const allowed = new Set(['events','page_view','scroll','heartbeat','read_complete','uniques','readSeconds']);
  if (allowed.has(sortKey)) {
    byPath.sort((a, b) => (Number(a[sortKey] || 0) - Number(b[sortKey] || 0)) * dir);
  }

  res.json({ ok: true, daily: { ...doc, byPath } });
});

// Latest N daily docs (default 7)
// GET /analytics/daily?limit=7
router.get('/daily', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '7', 10), 31);
  const docs = await AnalyticsDaily.find({}).sort({ date: -1 }).limit(limit).lean();
  res.json({ ok: true, items: docs });
});

/* ============================
   TREND
   ============================ */

// Simple trend of a daily metric over N days (default 14)
// GET /analytics/trend?metric=page_view&days=14
router.get('/trend', async (req, res) => {
  try {
    const metric = (req.query.metric || 'page_view').toString();
    const days = Math.min(parseInt(req.query.days || '14', 10), 60);

    const docs = await AnalyticsDaily.find({}).sort({ date: -1 }).limit(days).lean();
    const items = docs
      .map(d => ({ date: d.date, value: (d.totals && d.totals[metric]) || 0 }))
      .reverse();

    res.json({ ok: true, items });
  } catch (e) {
    console.error('GET /analytics/trend error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;
