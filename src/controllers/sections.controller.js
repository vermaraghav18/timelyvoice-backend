// backend/src/controllers/sections.controller.js
const Section = require("../models/Section");
const Ad = require("../models/Ad");

const planService = require("../services/sectionsPlan.service");

exports.list = async (req, res) => {
  const { targetType, targetValue } = req.query;
  const q = {};
  if (targetType) q["target.type"] = targetType;
  if (targetValue) q["target.value"] = targetValue;
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
  const doc = await Section.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!doc) return res.sendStatus(404);
  res.json(doc);
};

exports.remove = async (req, res) => {
  await Section.deleteOne({ _id: req.params.id });
  res.sendStatus(204);
};

/**
 * Build the page plan (homepage/category/path) and ensure essential fields
 * are present on every row so rails like rail_v7 can render.
 *
 * Merge priority:
 *  - by _id if present
 *  - else by slug if present
 *  - else by (template + placementIndex)
 *  - else fall back to same index order as DB query
 */
exports.plan = async (req, res) => {
  // Accept both naming styles (frontend uses sectionType/sectionValue)
  const sectionType  = req.query.sectionType  ?? req.query.targetType ?? req.query.target ?? "homepage";
  const sectionValue = req.query.sectionValue ?? req.query.targetValue ?? req.query.value  ?? ""; // homepage = ""

  const marketsService = req.app?.locals?.marketsService || req.services?.markets || null;

  // 1) Build service plan
  const planRows = await planService.buildPlan({
    targetType: sectionType,
    targetValue: sectionValue,
    marketsService,
  });
  const plan = Array.isArray(planRows) ? planRows : [];

  // 2) Fetch canonical sections
  const sections = await Section.find(
    { enabled: true, "target.type": sectionType, "target.value": sectionValue },
    "_id title slug template side custom moreLink placementIndex capacity target"
  )
    .sort({ placementIndex: 1, createdAt: 1 })
    .lean();

  // 3) Fetch ads defensively (include custom so we can carry afterNth)
  let adRows = [];
  try {
    const ads = await Ad.find(
      { enabled: true, "target.type": sectionType, "target.value": sectionValue },
      "_id imageUrl linkUrl placementIndex target custom"
    )
      .sort({ placementIndex: 1, createdAt: 1 })
      .lean();

    // ✅ Keep any `custom.afterNth` from the Ad document
    adRows = ads.map((a) => ({
      _id: a._id,
      template: "ad",
      title: "Sponsored",
      slug: "",
      side: "",
      custom: {
        imageUrl: a.imageUrl,
        link: a.linkUrl,
        ...(a.custom && typeof a.custom.afterNth !== "undefined"
          ? { afterNth: Number(a.custom.afterNth) }
          : {}),
      },
      moreLink: "",
      placementIndex: Number(a.placementIndex ?? 0),
      capacity: 0,
      target: a.target,
      _isAd: true,
    }));
  } catch (e) {
    console.error("Ads load failed:", e);
  }

  // Lookups
  const byId = new Map(sections.map((s) => [String(s._id), s]));
  const bySlug = new Map(sections.filter((s) => s.slug).map((s) => [s.slug, s]));
  const byTplIdx = new Map(sections.map((s) => [`${s.template}|${s.placementIndex}`, s]));
  const byIndex = sections;

  function matchSection(row, index) {
    if (!row) return null;
    const idKey = row._id ? String(row._id) : null;
    if (idKey && byId.has(idKey)) return byId.get(idKey);
    if (row.slug && bySlug.has(row.slug)) return bySlug.get(row.slug);
    const key = `${row.template}|${row.placementIndex ?? 0}`;
    if (byTplIdx.has(key)) return byTplIdx.get(key);
    return byIndex[index] || null;
  }

  // 4) Merge service rows with DB details
  const merged = plan.map((row, i) => {
    const extra = matchSection(row, i);
    return {
      ...row,
      template: row.template || extra?.template,
      title: row.title ?? extra?.title ?? "",
      slug: row.slug || extra?.slug || "",
      side: row.side ?? extra?.side ?? "",
      custom: row.custom ?? extra?.custom ?? {},
      moreLink: row.moreLink ?? extra?.moreLink ?? "",
      placementIndex: row.placementIndex ?? extra?.placementIndex ?? 0,
      capacity: row.capacity ?? extra?.capacity ?? 0,
      target: row.target || extra?.target,
      _id: row._id || extra?._id,
    };
  });

  // 5) Dedup + append ads
  const seen = new Set();
  const deduped = merged.filter((s) => {
    const key = `${s.slug}|${s.template}|${s.placementIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const withAds = deduped.concat(adRows);

  // 6) Final sort + respond
  const final = withAds
    .map((r) => ({
      ...r,
      placementIndex: Number.isFinite(Number(r.placementIndex)) ? Number(r.placementIndex) : 0,
    }))
    .sort((a, b) => a.placementIndex - b.placementIndex);

  return res.json(final);
};
