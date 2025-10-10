// backend/src/controllers/sections.controller.js
const Section = require('../models/Section');
const planService = require('../services/sectionsPlan.service');

exports.list = async (req, res) => {
  const { targetType, targetValue } = req.query;
  const q = {};
  if (targetType) q['target.type'] = targetType;
  if (targetValue) q['target.value'] = targetValue;
  const items = await Section.find(q).sort({ placementIndex: 1 });
  res.json(items);
};

exports.read = async (req, res) => {
  const doc = await Section.findById(req.params.id);
  if (!doc) return res.sendStatus(404);
  res.json(doc);
};

exports.create = async (req, res) => {
  const doc = await Section.create(req.body);
  res.status(201).json(doc);
};

exports.update = async (req, res) => {
  const doc = await Section.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.sendStatus(404);
  res.json(doc);
};

exports.remove = async (req, res) => {
  await Section.deleteOne({ _id: req.params.id });
  res.sendStatus(204);
};

/**
 * Build the homepage plan and ensure essential fields (slug / side / custom)
 * are present on every row so rails like rail_v7 can render.
 *
 * This version is more robust:
 * - It merges by _id if present
 * - Else by slug if present
 * - Else by (template + placementIndex)
 * - Else falls back to the same index order as the DB query
 */
exports.plan = async (req, res) => {
  const targetType = req.query.targetType || req.query.target || 'homepage';
  const targetValue = req.query.targetValue || req.query.value || '/';

  // 1) Get service plan (may be missing _id/slug/custom)
  const planRows = await planService.buildPlan({ targetType, targetValue });
  const plan = Array.isArray(planRows) ? planRows : [];

  // 2) Fetch canonical sections for this target (with the fields we need)
  const sections = await Section.find(
    { enabled: true, 'target.type': targetType, 'target.value': targetValue },
    '_id title slug template side custom moreLink placementIndex capacity target'
  )
    .sort({ placementIndex: 1, createdAt: 1 })
    .lean();

  // Build helpful lookups
  const byId = new Map(sections.map(s => [String(s._id), s]));
  const bySlug = new Map(
    sections
      .filter(s => s.slug)
      .map(s => [s.slug, s])
  );
  const byTplIdx = new Map(
    sections.map(s => [`${s.template}|${s.placementIndex}`, s])
  );

  // For index fallback
  const byIndex = sections; // already sorted

  // Merge helper: find best matching section for a plan row
  function matchSection(row, index) {
    if (!row) return null;
    const idKey = row._id ? String(row._id) : null;
    if (idKey && byId.has(idKey)) return byId.get(idKey);

    if (row.slug && bySlug.has(row.slug)) return bySlug.get(row.slug);

    const key = `${row.template}|${row.placementIndex ?? 0}`;
    if (byTplIdx.has(key)) return byTplIdx.get(key);

    // Last resort: align by order
    return byIndex[index] || null;
  }

  // 3) Merge rows with DB details
  const merged = plan.map((row, i) => {
    const extra = matchSection(row, i);
    return {
      ...row,
      template: row.template || extra?.template,
      title: row.title ?? extra?.title ?? '',
      slug: row.slug || extra?.slug || '',
      side: row.side ?? extra?.side ?? '',
      custom: row.custom ?? extra?.custom ?? {},
      moreLink: row.moreLink ?? extra?.moreLink ?? '',
      placementIndex: row.placementIndex ?? extra?.placementIndex ?? 0,
      capacity: row.capacity ?? extra?.capacity ?? 0,
      target: row.target || extra?.target,
      _id: row._id || extra?._id, // keep id if we can
    };
  });

  // 4) Deduplicate defensively
  const seen = new Set();
  const deduped = merged.filter((s) => {
    const key = `${s.slug}|${s.template}|${s.placementIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  res.json(deduped);
};
