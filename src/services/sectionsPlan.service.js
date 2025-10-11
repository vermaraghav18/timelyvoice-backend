// backend/src/services/sectionsPlan.service.js
const Section = require("../models/Section");
const Article = require("../models/Article");

/** Normalize image fields so FE can rely on { imageUrl, imageAlt } */
function normalizeMedia(a) {
  const cover = a.cover; // string or { url, alt }
  const imageUrl =
    a.imageUrl ||
    (typeof cover === "string" ? cover : null) ||
    (cover && typeof cover === "object" ? cover.url : null) ||
    null;

  const imageAlt =
    a.imageAlt ||
    (cover && typeof cover === "object" ? cover.alt : null) ||
    a.title ||
    "";

  return { imageUrl, imageAlt };
}

function stripArticleFields(a) {
  const { imageUrl, imageAlt } = normalizeMedia(a);
  return {
    id: a._id,
    title: a.title,
    slug: a.slug,
    summary: a.summary || "",
    imageUrl,
    imageAlt,
    publishedAt: a.publishedAt,
    author: a.author,
    category: a.category,
  };
}

// Include old + new names
const ARTICLE_FIELDS =
  "title slug summary imageUrl imageAlt cover publishedAt author category";

/* ------------------------------------------------------------------
 * Helper: run a flexible query for composite sections (e.g., top_v1)
 * ------------------------------------------------------------------ */
async function runQuery({ query = {}, limit = 4, excludeIds = [] } = {}) {
  const q = { publishedAt: { $ne: null } };
  if (Array.isArray(query.categories) && query.categories.length) {
    q.category = { $in: query.categories };
  }
  if (Array.isArray(query.tags) && query.tags.length) {
    q.tags = { $in: query.tags };
  }
  if (Array.isArray(query.includeIds) && query.includeIds.length) {
    q._id = { $in: query.includeIds.map(String) };
  }
  if (Array.isArray(excludeIds) && excludeIds.length) {
    q._id = q._id || {};
    q._id.$nin = excludeIds.map(String);
  }
  if (Number.isFinite(query.sinceDays) && query.sinceDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - query.sinceDays);
    q.publishedAt = { ...(q.publishedAt || {}), $gte: d };
  }

  let sort = { publishedAt: -1 };
  // Hook for future: views_7d / trending if you add fields
  if (query.sort === "publishedAt_asc") sort = { publishedAt: 1 };

  const rows = await Article.find(q).sort(sort).limit(limit).lean();
  return rows.map(stripArticleFields);
}

/**
 * Build the homepage plan
 * NOTE: now passes through slug/side/custom/placementIndex/target for all rows.
 * rail_v7 is image/promo only (no items), so it’s always included if enabled.
 */
exports.buildPlan = async ({ targetType = "homepage", targetValue = "/" } = {}) => {
  const sections = await Section.find({
    enabled: true,
    "target.type": targetType,
    "target.value": targetValue,
  })
    .select(
      "title slug template capacity moreLink side custom placementIndex target feed pins enabled"
    )
    .sort({ placementIndex: 1 })
    .lean();

  const now = new Date();
  const out = [];

  for (const s of sections) {
    // ---- Promo rail: rail_v7 (image only) ----
    if (s.template === "rail_v7") {
      out.push({
        id: String(s._id),
        title: s.title,
        slug: s.slug,
        template: s.template,
        side: s.side || "right", // allow renderer to place it
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: 1, // fixed single
        moreLink: s.moreLink || "",
        custom: s.custom || {}, // << contains imageUrl/alt/linkUrl/aspect
        items: [], // << important: render even with no items
      });
      continue;
    }

    // ---- Promo rail: rail_v8 (content card) ----
    if (s.template === "rail_v8") {
      out.push({
        id: String(s._id),
        title: s.title,
        slug: s.slug,
        template: "rail_v8",
        side: s.side || "right",
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: 1,
        moreLink: s.moreLink || "",
        items: [],
        custom: s.custom || {}, // { imageUrl, title, summary, linkUrl? }
      });
      continue;
    }

    // ---- Composite section: top_v1 ----
    if (s.template === "top_v1") {
      const cfg = s.custom || {};
      const dedupe = !!cfg.dedupeAcrossZones;
      const used = new Set();

      const take = async (zone = {}, fallbackLimit = 0) => {
        if (zone?.enable === false) return [];
        const lim = Number(zone?.limit ?? fallbackLimit);
        const list = await runQuery({
          query: zone?.query || {},
          limit: lim,
          excludeIds: dedupe ? Array.from(used) : [],
        });
        if (dedupe) list.forEach((a) => used.add(String(a.id || a._id)));
        return list;
      };

      const zoneItems = {
        topStrip: await take(cfg.topStrip, 4),
        lead: (await take({ ...(cfg.lead || {}), limit: 1 }, 1)).slice(0, 1),
        rightStack: await take(cfg.rightStack, 2),
        freshStories: await take(cfg.freshStories, 10),
        popular: await take(cfg.popular, 10),
      };

      out.push({
        id: String(s._id),
        title: s.title,
        slug: s.slug,
        template: s.template,
        side: "", // center/main
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: 0,
        moreLink: s.moreLink || "",
        custom: { ...(s.custom || {}), zoneItems },
        items: [], // renderer relies on custom.zoneItems
      });
      continue;
    }

    // ---- Composite section: top_v2 ----
    if (s.template === "top_v2") {
      const cfg = s.custom || {};
      const dedupe = !!cfg.dedupeAcrossZones;
      const used = new Set();

      const take = async (zone = {}, fallbackLimit = 0) => {
        if (zone?.enable === false) return [];
        const lim = Number(zone?.limit ?? fallbackLimit);
        const list = await runQuery({
          query: zone?.query || {},
          limit: lim,
          excludeIds: dedupe ? Array.from(used) : [],
        });
        if (dedupe) list.forEach((a) => used.add(String(a.id || a._id)));
        return list;
      };

      const zoneItems = {
        hero: (await take({ ...(cfg.hero || {}), limit: 1 }, 1)).slice(0, 1),
        sideStack: await take(cfg.sideStack, 3),
        belowGrid: await take(cfg.belowGrid, 6),
        trending: await take(cfg.trending, 10),
      };

      out.push({
        id: String(s._id),
        title: s.title,
        slug: s.slug,
        template: s.template,
        side: "", // center/main
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: 0,
        moreLink: s.moreLink || "",
        custom: s.custom || {},
        items: zoneItems, // NOTE: composite payload for top_v2
      });
      continue;
    }

    // ---- Feed/pinned sections (existing behavior) ----
    const activePins = (s.pins || []).filter(
      (p) => (!p.startAt || p.startAt <= now) && (!p.endAt || p.endAt >= now)
    );
    const pinIds = activePins.map((p) => p.articleId);
    let orderedPins = [];

    if (pinIds.length) {
      const pinDocs = await Article.find({
        _id: { $in: pinIds },
        status: "published",
      })
        .select(ARTICLE_FIELDS)
        .lean();

      const map = new Map(pinDocs.map((a) => [String(a._id), a]));
      orderedPins = activePins
        .map((p) => map.get(String(p.articleId)))
        .filter(Boolean);
    }

    // Auto-fill remaining slots unless feed is manual
    let autoItems = [];
    if (s.feed?.mode !== "manual") {
      const q = { status: "published" };
      if (s.feed?.categories?.length) q.category = { $in: s.feed.categories };
      if (s.feed?.tags?.length) q.tags = { $in: s.feed.tags };
      if (s.feed?.timeWindowHours > 0) {
        q.publishedAt = {
          $gte: new Date(Date.now() - s.feed.timeWindowHours * 3600 * 1000),
        };
      }

      const sort =
        s.feed?.sortBy === "priority"
          ? { priority: -1, publishedAt: -1 }
          : { publishedAt: -1 };

      autoItems = await Article.find(q)
        .select(ARTICLE_FIELDS)
        .sort(sort)
        .limit(Math.max(0, (s.capacity || 0) - orderedPins.length))
        .lean();
    }

    const items = [...orderedPins, ...autoItems]
      .slice(0, s.capacity || 0)
      .map(stripArticleFields);

    out.push({
      id: String(s._id),
      title: s.title,
      slug: s.slug,
      template: s.template,
      side: s.side || "", // usually empty for mains, used by rails
      placementIndex: s.placementIndex || 0,
      target: s.target,
      capacity: s.capacity || 0,
      moreLink: s.moreLink || "",
      custom: s.custom || {}, // harmless for non-rail_v7 rows
      items,
    });
  }

  return out;
};
