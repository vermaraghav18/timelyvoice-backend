// backend/src/services/sectionsPlan.service.js
const Section = require("../models/Section");
const Article = require("../models/Article");

/* =============================== Utilities =============================== */

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
    category: a.category,       // display category
    // categorySlug: a.categorySlug, // uncomment if FE wants slug too
  };
}

// Light list projection (skip heavy fields)
const PROJECTION_LIST = {
  body: 0,
  bodyHtml: 0,
};

// Include old + new names
const ARTICLE_FIELDS =
  "title slug summary imageUrl imageAlt cover publishedAt author category categorySlug tags";

/** Escape string for building a safe RegExp */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize array of strings */
function normArray(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return arr.map((x) => String(x || "").trim()).filter(Boolean);
}

/* ------------------------------------------------------------------
 * Helper: run a flexible query for composite sections
 * - honors status=published
 * - accepts categories against either `category` or `categorySlug`
 * - dedupes by excludeIds
 * - supports tags, includeIds, sinceDays, and sort
 * ------------------------------------------------------------------ */
async function runQuery({ query = {}, limit = 4, excludeIds = [] } = {}) {
  const q = { status: "published", publishedAt: { $ne: null } };

  const cats = Array.isArray(query.categories) ? query.categories.filter(Boolean) : [];
  if (cats.length) {
    q.$or = [
      { category: { $in: cats } },
      { categorySlug: { $in: cats } },
    ];
  }

  const tags = Array.isArray(query.tags) ? query.tags.filter(Boolean) : [];
  if (tags.length) q.tags = { $in: tags };

  const includeIds = Array.isArray(query.includeIds) ? query.includeIds.map(String) : [];
  if (includeIds.length) q._id = { $in: includeIds };

  if (Array.isArray(excludeIds) && excludeIds.length) {
    q._id = q._id || {};
    q._id.$nin = excludeIds.map(String);
  }

  if (Number.isFinite(query.sinceDays) && query.sinceDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - query.sinceDays);
    q.publishedAt = { ...(q.publishedAt || {}), $gte: d };
  }

  // Clamp limit and exclude heavy fields for list feeds
  const hardLimit = Math.min(Number(limit || 12), 12);

  const SORT =
    query.sort === "publishedAt_asc"
      ? { publishedAt: 1, _id: 1 }
      : { publishedAt: -1, _id: -1 };

      // Slice / offset (1-based)
const from1 = Number(query?.sliceFrom) || 1;
const to1 = Number.isFinite(query?.sliceTo) ? Number(query.sliceTo) : undefined;
const offset = Math.max(0, from1 - 1);
const effLimit = Number.isFinite(to1)
  ? Math.min(hardLimit, Math.max(0, to1 - from1 + 1))
  : hardLimit;

  const rows = await Article.find(q, PROJECTION_LIST)
  .sort(SORT)
  .skip(offset)
  .limit(effLimit)
  .lean({ getters: true })
  .maxTimeMS(5000);


  return rows.map(stripArticleFields);
}

/* =============================== Plan Builder =============================== */

/**
 * Build the plan for a given target.
 * Accepts either:
 * - { sectionType, sectionValue } (from client)
 * - { targetType, targetValue }  (legacy / internal)
 */
exports.buildPlan = async (params = {}) => {
  // Accept aliases & normalize
  const targetType =
    String(params.sectionType || params.targetType || "homepage").toLowerCase();
  const rawTargetValue = String(params.sectionValue || params.targetValue || "/");
  const targetValue = rawTargetValue; // do not lowerCase here; use case-insensitive match in DB query

  // Case-insensitive match for target.value so Admin can save "Politics" while FE sends "politics"
  const valueRe = new RegExp(`^${escapeRegExp(targetValue)}$`, "i");

  // Pull all enabled sections for this target
  const sections = await Section.find({
    enabled: true,
    "target.type": targetType,
    "target.value": valueRe,
  })
    .select(
      "title slug template capacity moreLink side custom placementIndex target feed pins enabled"
    )
    .sort({ placementIndex: 1 })
    .lean();

  const now = new Date();
  const out = [];

  for (const s of sections) {
    /* ===================== rail_v7: image promo (no items) ===================== */
    if (s.template === "rail_v7") {
      out.push({
        id: String(s._id),
        title: s.title,
        slug: s.slug,
        template: s.template,
        side: s.side || "right",
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: 1,
        moreLink: s.moreLink || "",
        custom: s.custom || {}, // { imageUrl, alt, linkUrl, aspect }
        items: [],
      });
      continue;
    }

    /* ===================== rail_v8: promo content card ===================== */
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

    /* ===================== tech_main_v1 (center/main grid) ===================== */
    if (s.template === "tech_main_v1") {
      const limit = Math.max(1, Number(s.capacity ?? 9));
      const shape = (rows) => rows.map(stripArticleFields);
      const mode = s.feed?.mode || "auto";

      // Safe category fallback:
      const pageCat = targetType === "category"
        ? String(targetValue).trim().toLowerCase()
        : "";
      const pageCatCap = pageCat ? pageCat.charAt(0).toUpperCase() + pageCat.slice(1) : "";

      const buildCategoryFallback = (q0 = {}) => {
        const q = { ...(q0 || {}) };
        const cats = normArray(q.categories);
        if (!cats.length) {
          const secCats = normArray(s.feed?.categories);
          if (secCats.length) q.categories = secCats;
          else if (pageCat) q.categories = [pageCat, pageCatCap];
          else q.categories = ["tech"]; // last resort default
        }
        return q;
      };

      let rows = [];

      if (mode === "manual" || mode === "mixed") {
        // ordered, active pins
        const activePins = (s.pins || []).filter(
          (p) => (!p.startAt || p.startAt <= now) && (!p.endAt || p.endAt >= now)
        );
        const pinIds = activePins.map((p) => p.articleId);

        if (pinIds.length) {
          const pinDocs = await Article.find(
            { _id: { $in: pinIds }, status: "published" },
            PROJECTION_LIST
          )
            .sort({ publishedAt: -1, createdAt: -1 })
            .limit(limit)
            .lean({ getters: true })
            .maxTimeMS(5000);

          const byId = new Map(pinDocs.map((d) => [String(d._id), d]));
          rows = activePins.map((p) => byId.get(String(p.articleId))).filter(Boolean);
        }

        if (mode === "mixed" && rows.length < limit) {
          const excludeIds = rows.map((a) => String(a._id || a.id));
          const q = buildCategoryFallback(s.feed?.query || {});
          const topUp = await runQuery({
            query: q,
            limit: limit - rows.length,
            excludeIds,
          });
          rows = [...rows, ...topUp];
        }
      } else {
        // AUTO: derive categories from feed or page; default to 'tech'
        const q = buildCategoryFallback(s.feed?.query || {});
        rows = await runQuery({ query: q, limit });
      }

      const pins = rows.slice(0, limit);
      const hero = pins.slice(0, 1);
      const mids = pins.slice(1, 3);
      const heads = pins.slice(3, 9);

      const items = [...shape(hero), ...shape(mids), ...shape(heads)];

      out.push({
        id: String(s._id),
        title: s.title,
        slug: s.slug,
        template: "tech_main_v1",
        side: s.side || "",
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: limit,
        moreLink: s.moreLink || "",
        custom: s.custom || {},
        items,
      });
      continue;
    }

    /* ===================== top_v1 (composite zones) ===================== */
    if (s.template === "top_v1") {
      const cfg = s.custom || {};
      const dedupe = !!cfg.dedupeAcrossZones;
      const used = new Set();

      // Global slice range from section feed (1-based)
      const globalFrom = Number(s.feed?.sliceFrom) || 1;
      
      const globalTo = Number.isFinite(s.feed?.sliceTo) ? Number(s.feed.sliceTo) : undefined;
      let cursor = Math.max(1, globalFrom);


      const pageCat = targetType === "category"
        ? String(targetValue).trim().toLowerCase()
        : "";
      const pageCatCap = pageCat ? pageCat.charAt(0).toUpperCase() + pageCat.slice(1) : "";

      const mergeQuery = (zoneQuery = {}) => {
        const q = { ...(zoneQuery || {}) };
        const explicit = normArray(q.categories);
        if (!explicit.length) {
          const secCats = normArray(s.feed?.categories);
          if (secCats.length) q.categories = secCats;
          else if (pageCat) q.categories = [pageCat, pageCatCap];
        }
        return q;
      };

      // NEW: canonical list (FE will render this exact list)
// respects Admin feed.sliceFrom/sliceTo and categories (like top_v2)
const gridLimit = Math.max(1, Number(s.capacity ?? 6));
const sliceFrom = Number(s.feed?.sliceFrom) || Number((s.custom || {}).offset ?? (s.custom || {}).afterNth ?? 0) + 1; // 1-based
const sliceTo = Number.isFinite(s.feed?.sliceTo) ? Number(s.feed.sliceTo) : undefined;

const baseQuery = mergeQuery((s.custom && s.custom.query) || {});
const canonicalItems = await runQuery({
  query: {
    ...baseQuery,
    sliceFrom,
    ...(Number.isFinite(sliceTo) ? { sliceTo } : {}),
  },
  limit: gridLimit,
  excludeIds: dedupe ? Array.from(used) : [],
});


     const take = async (zone = {}, fallbackLimit = 0) => {
  if (zone?.enable === false) return [];
  const lim = Number(zone?.limit ?? fallbackLimit);

  // Compose this zone's slice from the global cursor
  const zoneFrom = cursor;
  const zoneTo = Number.isFinite(globalTo) ? Math.min(globalTo, zoneFrom + lim - 1) : undefined;

  const list = await runQuery({
    query: {
      ...mergeQuery(zone?.query || {}),
      sliceFrom: zoneFrom,
      ...(Number.isFinite(zoneTo) ? { sliceTo: zoneTo } : {}),
    },
    limit: lim,
    excludeIds: dedupe ? Array.from(used) : [],
  });

  if (dedupe) list.forEach((a) => used.add(String(a.id || a._id)));

  // Advance global cursor for next zone
  cursor = zoneFrom + lim;
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
        side: "",
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: 0,
        moreLink: s.moreLink || "",
        custom: { ...(s.custom || {}), zoneItems },
        items: [],
      });
      continue;
    }

    /* ===================== top_v2 (composite zones - fixed) ===================== */
    if (s.template === "top_v2") {
      const cfg = s.custom || {};
      const dedupe = !!cfg.dedupeAcrossZones;
      const used = new Set();
      const globalFrom = Number(s.feed?.sliceFrom) || 1;
      const globalTo = Number.isFinite(s.feed?.sliceTo) ? Number(s.feed.sliceTo) : undefined;
      let cursor = Math.max(1, globalFrom);

      // page context (category page fallback)
      const pageCat = targetType === "category"
        ? String(targetValue).trim().toLowerCase()
        : "";
      const pageCatCap = pageCat ? pageCat.charAt(0).toUpperCase() + pageCat.slice(1) : "";

      const mergeQuery = (zoneQuery = {}) => {
        const q = { ...(zoneQuery || {}) };
        const explicit = normArray(q.categories);
        if (!explicit.length) {
          const secCats = normArray(s.feed?.categories);
          if (secCats.length) q.categories = secCats;
          else if (pageCat) q.categories = [pageCat, pageCatCap];
        }
        return q;
      };

        const take = async (zone = {}, fallbackLimit = 0) => {
    if (zone?.enable === false) return [];
    const lim = Number(zone?.limit ?? fallbackLimit);

    // Compute this zone's slice window from the global cursor
    const zoneFrom = cursor;
    const zoneTo = Number.isFinite(globalTo) ? Math.min(globalTo, zoneFrom + lim - 1) : undefined;

    const list = await runQuery({
      query: {
        ...mergeQuery(zone?.query || {}),
        sliceFrom: zoneFrom,
        ...(Number.isFinite(zoneTo) ? { sliceTo: zoneTo } : {}),
      },
      limit: lim,
      excludeIds: dedupe ? Array.from(used) : [],
    });

    if (dedupe) list.forEach((a) => used.add(String(a.id || a._id)));

    // Advance the global cursor by the requested window for sequential consumption
    cursor = zoneFrom + lim;
    return list;
  };


      const shape = (rows) => rows.map(stripArticleFields);
      const mode = s.feed?.mode || "auto";
      let zoneItems = { hero: [], sideStack: [], belowGrid: [], trending: [] };

      if (mode === "manual" || mode === "mixed") {
        // ordered, active pins
        const activePins = (s.pins || []).filter(
          (p) => (!p.startAt || p.startAt <= now) && (!p.endAt || p.endAt >= now)
        );
        const pinIds = activePins.map((p) => p.articleId);

        let pins = [];
        if (pinIds.length) {
          const pinDocs = await Article.find(
            { _id: { $in: pinIds }, status: "published" },
            ARTICLE_FIELDS
          ).lean({ getters: true });

          const byId = new Map(pinDocs.map((a) => [String(a._id), a]));
          pins = activePins.map((p) => byId.get(String(p.articleId))).filter(Boolean);
        }

        // Map pins to zones: 1 / 3 / 6 / 10
        const heroPins = pins.slice(0, 1);
        const sidePins = pins.slice(1, 1 + 3);
        const belowPins = pins.slice(1 + 3, 1 + 3 + 6);
        const trendPins = pins.slice(1 + 3 + 6, 1 + 3 + 6 + 10);

        zoneItems.hero = shape(heroPins);
        zoneItems.sideStack = shape(sidePins);
        zoneItems.belowGrid = shape(belowPins);
        zoneItems.trending = shape(trendPins);

        if (dedupe) {
          [...zoneItems.hero, ...zoneItems.sideStack, ...zoneItems.belowGrid, ...zoneItems.trending]
            .forEach((a) => used.add(String(a.id)));
        }

        if (mode === "mixed") {
          const heroNeed  = Math.max(0, Number(cfg.hero?.limit ?? 1)  - zoneItems.hero.length);
          const sideNeed  = Math.max(0, Number(cfg.sideStack?.limit ?? 3) - zoneItems.sideStack.length);
          const belowNeed = Math.max(0, Number(cfg.belowGrid?.limit ?? 6) - zoneItems.belowGrid.length);
          const trendNeed = Math.max(0, Number(cfg.trending?.limit ?? 10) - zoneItems.trending.length);

          if (heroNeed > 0) {
            const extra = await take({ ...(cfg.hero || {}), limit: heroNeed }, heroNeed);
            zoneItems.hero = [...zoneItems.hero, ...extra].slice(0, cfg.hero?.limit ?? 1);
          }
          if (sideNeed > 0) {
            const extra = await take({ ...(cfg.sideStack || {}), limit: sideNeed }, sideNeed);
            zoneItems.sideStack = [...zoneItems.sideStack, ...extra].slice(0, cfg.sideStack?.limit ?? 3);
          }
          if (belowNeed > 0) {
            const extra = await take({ ...(cfg.belowGrid || {}), limit: belowNeed }, belowNeed);
            zoneItems.belowGrid = [...zoneItems.belowGrid, ...extra].slice(0, cfg.belowGrid?.limit ?? 6);
          }
          if (trendNeed > 0) {
            const extra = await take({ ...(cfg.trending || {}), limit: trendNeed }, trendNeed);
            zoneItems.trending = [...zoneItems.trending, ...extra].slice(0, cfg.trending?.limit ?? 10);
          }
        }
      } else {
        // AUTO (default): inherit categories from section/page
        zoneItems = {
          hero: (await take({ ...(cfg.hero || {}), limit: 1 }, 1)).slice(0, 1),
          sideStack: await take({ ...(cfg.sideStack || {}) }, 3),
          belowGrid: await take({ ...(cfg.belowGrid || {}) }, 6),
          trending: await take({ ...(cfg.trending || {}) }, 10),
        };
      }

      out.push({
        id: String(s._id),
        title: s.title,
        slug: s.slug,
        template: s.template,
        side: "",
        placementIndex: s.placementIndex || 0,
        target: s.target,
        capacity: 0,
        moreLink: s.moreLink || "",
        custom: s.custom || {},
        items: zoneItems,
      });
      continue;
    }

    /* ===================== Generic feed/pinned sections ===================== */
    const activePins = (s.pins || []).filter(
      (p) => (!p.startAt || p.startAt <= now) && (!p.endAt || p.endAt >= now)
    );
    const pinIds = activePins.map((p) => p.articleId);
    let orderedPins = [];

    if (pinIds.length) {
      const pinDocs = await Article.find(
        { _id: { $in: pinIds }, status: "published" },
        ARTICLE_FIELDS
      )
        .lean({ getters: true })
        .maxTimeMS(5000);

      const map = new Map(pinDocs.map((a) => [String(a._id), a]));
      orderedPins = activePins.map((p) => map.get(String(p.articleId))).filter(Boolean);
    }

    let autoItems = [];
    if (s.feed?.mode !== "manual") {
      // Build a simple query for generic feeds
      const q = { status: "published" };

      const secCats = normArray(s.feed?.categories);
      // If no categories set in Admin and this is a category page, fallback to page context
      if (!secCats.length && targetType === "category") {
        const pageCat = String(targetValue).trim().toLowerCase();
        const pageCatCap = pageCat ? pageCat.charAt(0).toUpperCase() + pageCat.slice(1) : "";
        q.$or = [
          { category: { $in: [pageCat, pageCatCap] } },
          { categorySlug: { $in: [pageCat, pageCatCap] } },
        ];
      } else if (secCats.length) {
        q.$or = [
          { category: { $in: secCats } },
          { categorySlug: { $in: secCats } },
        ];
      }

      const secTags = normArray(s.feed?.tags);
      if (secTags.length) q.tags = { $in: secTags };

      if (Number(s.feed?.timeWindowHours) > 0) {
        q.publishedAt = {
          $gte: new Date(Date.now() - Number(s.feed.timeWindowHours) * 3600 * 1000),
        };
      }

      const SORT =
        s.feed?.sortBy === "priority"
          ? { priority: -1, publishedAt: -1, _id: -1 }
          : { publishedAt: -1, _id: -1 };

          // Enforce exactly two items for m10
if (s.template === "m10") s.capacity = 2;


     const capClamp = Math.min(Number(s.capacity || 0), 12);

// Slice / offset (1-based)
const from1 = Number(s.feed?.sliceFrom) || 1;
const to1 = Number.isFinite(s.feed?.sliceTo) ? Number(s.feed.sliceTo) : undefined;
const offset = Math.max(0, from1 - 1);
const rangeCount = Number.isFinite(to1) ? Math.max(0, to1 - from1 + 1) : undefined;

// Effective capacity for auto (pins not counted here)
const effCap = Math.min(capClamp, Number.isFinite(rangeCount) ? rangeCount : capClamp);

// How many auto items still needed after pins
const need = Math.max(0, effCap - orderedPins.length);

autoItems = await Article.find(q, PROJECTION_LIST)
  .sort(SORT)
  .skip(offset)
  .limit(need)
  .lean({ getters: true })
  .maxTimeMS(5000);

    }

    const hardCapacity = Math.min(Number(s.capacity || 0), 12);
    const items = [...orderedPins, ...autoItems].slice(0, hardCapacity).map(stripArticleFields);

    out.push({
      id: String(s._id),
      title: s.title,
      slug: s.slug,
      template: s.template,
      side: s.side || "",
      placementIndex: s.placementIndex || 0,
      target: s.target,
      capacity: s.capacity || 0,
      moreLink: s.moreLink || "",
      custom: s.custom || {},
      items,
    });
  }

  return out;
};
