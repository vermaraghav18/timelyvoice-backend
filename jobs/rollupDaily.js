const AnalyticsEvent = require('../models/AnalyticsEvent');
const AnalyticsDaily = require('../models/AnalyticsDaily');

function toUTCDateString(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getBoundsForDateString(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));
  return { start, end };
}

async function rollupDaily(dateStr) {
  const date = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : new Date();
  const targetDate = toUTCDateString(date);
  const { start, end } = getBoundsForDateString(targetDate);

  const baseMatch = {
    createdAt: { $gte: start, $lt: end },
    'flags.isBot': { $ne: true },
    'flags.isAdmin': { $ne: true },
    'flags.dnt': { $ne: true },
    'flags.optOut': { $ne: true },
  };

  // ---- totals by type ----
  const totalsAgg = await AnalyticsEvent.aggregate([
    { $match: baseMatch },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]);
  const totals = { events: 0, page_view: 0, scroll: 0, heartbeat: 0, read_complete: 0, uniqueVisitors: 0 };
  for (const t of totalsAgg) {
    totals.events += t.count;
    if (totals[t._id] != null) totals[t._id] = t.count;
  }
  const uniq = await AnalyticsEvent.distinct('visitorId', baseMatch);
  totals.uniqueVisitors = uniq.filter(Boolean).length;

  // ---- per path counts ----
  const byPathAgg = await AnalyticsEvent.aggregate([
    { $match: baseMatch },
    { $group: { _id: { path: '$path', type: '$type' }, count: { $sum: 1 } } },
  ]);
  const pathMap = new Map();
  for (const r of byPathAgg) {
    const path = r._id.path || '/';
    const type = r._id.type;
    const cur = pathMap.get(path) || { path, events: 0, page_view: 0, scroll: 0, heartbeat: 0, read_complete: 0, uniques: 0, readSeconds: 0 };
    cur.events += r.count;
    if (cur[type] != null) cur[type] += r.count;
    pathMap.set(path, cur);
  }

  // readSeconds from heartbeat (15s)
  const heartbeat = await AnalyticsEvent.aggregate([
    { $match: { ...baseMatch, type: 'heartbeat' } },
    { $group: { _id: '$path', beats: { $sum: 1 } } },
  ]);
  for (const r of heartbeat) {
    const path = r._id || '/';
    const cur = pathMap.get(path) || { path, events: 0, page_view: 0, scroll: 0, heartbeat: 0, read_complete: 0, uniques: 0, readSeconds: 0 };
    cur.readSeconds = (r.beats || 0) * 15;
    pathMap.set(path, cur);
  }

  // per-path uniques
  const pathUniq = await AnalyticsEvent.aggregate([
    { $match: baseMatch },
    { $group: { _id: { path: '$path', visitorId: '$visitorId' }, c: { $sum: 1 } } },
    { $group: { _id: '$_id.path', uniques: { $sum: 1 } } },
  ]);
  for (const r of pathUniq) {
    const path = r._id || '/';
    const cur = pathMap.get(path) || { path, events: 0, page_view: 0, scroll: 0, heartbeat: 0, read_complete: 0, uniques: 0, readSeconds: 0 };
    cur.uniques = r.uniques || 0;
    pathMap.set(path, cur);
  }
  const byPath = Array.from(pathMap.values()).sort((a, b) => b.page_view - a.page_view);

  // ---- Top UTMs (already added) ----
  const utmAgg = await AnalyticsEvent.aggregate([
    { $match: baseMatch },
    { $group: { _id: { s: '$utm.source', m: '$utm.medium', c: '$utm.campaign', type: '$type' }, cnt: { $sum: 1 } } },
  ]);
  const utmMap = new Map();
  for (const r of utmAgg) {
    const k = `${r._id.s || ''}|${r._id.m || ''}|${r._id.c || ''}`;
    const cur = utmMap.get(k) || { source: r._id.s || null, medium: r._id.m || null, campaign: r._id.c || null, page_view: 0, read_complete: 0, uniques: 0 };
    if (r._id.type === 'page_view') cur.page_view += r.cnt;
    if (r._id.type === 'read_complete') cur.read_complete += r.cnt;
    utmMap.set(k, cur);
  }
  const utmUniq = await AnalyticsEvent.aggregate([
    { $match: baseMatch },
    { $group: { _id: { s: '$utm.source', m: '$utm.medium', c: '$utm.campaign', visitorId: '$visitorId' } } },
    { $group: { _id: { s: '$_id.s', m: '$_id.m', c: '$_id.c' }, uniques: { $sum: 1 } } },
  ]);
  for (const r of utmUniq) {
    const k = `${r._id.s || ''}|${r._id.m || ''}|${r._id.c || ''}`;
    const cur = utmMap.get(k) || { source: r._id.s || null, medium: r._id.m || null, campaign: r._id.c || null, page_view: 0, read_complete: 0, uniques: 0 };
    cur.uniques = r.uniques || 0;
    utmMap.set(k, cur);
  }
  const topUTMs = Array.from(utmMap.values()).sort((a, b) => b.page_view - a.page_view).slice(0, 20);

 // ---- NEW: Top Countries ----
// We coalesce the flattened field `country` (set by the collector) with the legacy `geo.country`.
// That way old and new events both count.
const countryAgg = await AnalyticsEvent.aggregate([
  { $match: baseMatch },
  {
    $group: {
      _id: {
        cc: { $ifNull: ['$country', '$geo.country'] }, // <— CHANGE #1
        type: '$type',
      },
      cnt: { $sum: 1 },
    },
  },
]);

const countryMap = new Map();
for (const r of countryAgg) {
  const cc = r._id.cc || null;               // keep a null bucket for truly missing data
  const cur = countryMap.get(cc) || { country: cc, page_view: 0, uniques: 0 };
  if (r._id.type === 'page_view') cur.page_view += r.cnt;
  countryMap.set(cc, cur);
}

// Uniques per country (same coalesce)
const countryUniq = await AnalyticsEvent.aggregate([
  { $match: baseMatch },
  {
    $group: {
      _id: {
        cc: { $ifNull: ['$country', '$geo.country'] }, // <— CHANGE #2
        visitorId: '$visitorId',
      },
    },
  },
  { $group: { _id: '$_id.cc', uniques: { $sum: 1 } } },
]);

for (const r of countryUniq) {
  const cc = r._id || null;
  const cur = countryMap.get(cc) || { country: cc, page_view: 0, uniques: 0 };
  cur.uniques = r.uniques || 0;
  countryMap.set(cc, cur);
}

const topCountries = Array.from(countryMap.values())
  .sort((a, b) => b.page_view - a.page_view)
  .slice(0, 20);

  // ---- persist ----
  await AnalyticsDaily.updateOne(
    { date: targetDate },
    {
      $set: {
        date: targetDate,
        totals,
        byPath,
        generatedAt: new Date(),
        topUTMs,
        topCountries, // NEW
      },
    },
    { upsert: true }
  );

  return {
    date: targetDate,
    totals,
    paths: byPath.length,
    topUTMs: topUTMs.length,
    topCountries: topCountries.length,
  };
}

module.exports = { rollupDaily };
