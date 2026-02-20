// -----------------------------------------------------------------------------
// backend/src/services/imagePicker.js
// CLOUDINARY-ONLY Auto-Image System (STRICT TAG-FIRST, NORMALIZED + STEMMED)
// -----------------------------------------------------------------------------
// RULES (NO EXCEPTIONS):
// 1) If article has tags → ONLY Cloudinary images with matching tags are allowed
// 2) If no tag-matching images → RETURN null (never pick random)
// 3) Context / public_id are SECONDARY signals (after tags)
// 4) ✅ NEW: HARD MIN REQUIRED MATCHES (default 3). If < 3 → RETURN null (default image)
// 5) If article tags are only "generic" (world/news/etc) → RETURN null
// 6) Accept tags in multiple shapes (string/array/objects) and normalize them
// 7) Expand compound tags like "iran_missile" / "iran-missile" into tokens
// 8) Multi-entity enforcement (no retagging needed):
//    - If article contains 2+ strong "entity-like" tokens, prefer images that contain ALL.
//    - Penalize images missing those entities (fixes Rahul+Modi picking Rahul-only images).
// -----------------------------------------------------------------------------
//
// NOTE: This file intentionally returns null when it cannot find a strong match.
// Your caller should then use CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID (default hero).
// -----------------------------------------------------------------------------

const { v2: cloudinary } = require("cloudinary");

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || "news-images";
const MAX_CANDIDATES = Number(process.env.CLOUDINARY_AUTOPICK_MAX || 80);
const MIN_SCORE = Number(process.env.CLOUDINARY_AUTOPICK_MIN_SCORE || 3);

// ✅ NEW: HARD minimum required tag matches (no fallback)
const MIN_REQUIRED_TAG_MATCHES = Number(
  process.env.CLOUDINARY_AUTOPICK_MIN_REQUIRED_TAG_MATCHES || 3
);

// Exclude prefixes from auto-pick (comma-separated)
// Default excludes AI folder inside the configured folder.
const EXCLUDE_PREFIXES = (
  process.env.CLOUDINARY_AUTOPICK_EXCLUDE_PREFIXES || `${CLOUDINARY_FOLDER}/ai/`
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// -----------------------------------------------------------------------------
// UTILS
// -----------------------------------------------------------------------------
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "on",
  "in",
  "by",
  "at",
  "as",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "from",
  "with",
  "over",
  "under",
  "into",
  "out",
  "new",
  "latest",
  "says",
  "said",
  "report",
]);

// "generic" tags that are too broad to decide an image
const GENERIC_TAGS = new Set([
  "world",
  "india",
  "news",
  "politics",
  "business",
  "sports",
  "technology",
  "tech",
  "entertainment",
  "breaking",
  "latest",
  "update",
  "general",

  // Countries / locations (too broad to be “strong” matches)
  "canada",
  "usa",
  "us",
  "unitedstates",
  "uk",
  "uae",
  "newzealand",
  "australia",
  "china",
  "russia",
  "iran",
  "israel",
  "pakistan",
  "afghanistan",
  "srilanka",
  "sri-lanka",
  "japan",
  "france",
  "germany",
  "italy",
  "spain",
  "qatar",
  "saudi",
  "saudiarabia",
  "turkey",
  "ukraine",
]);

// Heuristic: tokens that are NOT "people/entity-like" (events/verbs/common news terms)
// Used so "missile/attack/blast" doesn't trigger multi-entity mode.
const NON_ENTITY_KEYWORDS = new Set([
  "attack",
  "attacks",
  "attacked",
  "airstrike",
  "airstrikes",
  "strike",
  "strikes",
  "missile",
  "missiles",
  "rocket",
  "rockets",
  "bomb",
  "blast",
  "explosion",
  "explosions",
  "war",
  "conflict",
  "clash",
  "clashes",
  "ceasefire",
  "border",
  "speech",
  "speeches",
  "rally",
  "rallies",
  "meeting",
  "meets",
  "met",
  "vote",
  "voting",
  "election",
  "elections",
  "campaign",
  "protest",
  "protests",
  "arrest",
  "arrests",
  "court",
  "verdict",
  "case",
  "probe",
  "raid",
  "raids",
  "budget",
  "tax",
  "inflation",
  "rates",
  "market",
  "stocks",
  "share",
  "shares",
  "cricket",
  "match",
  "matches",
  "tournament",
  "final",
  "semi",
  "league",
  "wins",
  "win",
  "lost",
  "loss",
  "defeat",
  "defeats",
  "dies",
  "dead",
  "death",
  "killed",
  "injured",
]);

function dedupe(arr) {
  return Array.from(new Set(arr));
}

function stem(t) {
  if (!t) return "";
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("s") && t.length > 3) return t.slice(0, -1);
  return t;
}

// Normalize hashtags and junk ("#Iran " -> "iran")
function normalizeTag(raw = "") {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const noHash = s.replace(/^#+/g, "");
  // keep underscore and hyphen (we will tokenize them later)
  const clean = noHash.replace(/[^a-z0-9_-]/g, "");
  return clean;
}

function normStemTag(raw = "") {
  return stem(normalizeTag(raw));
}

function isGenericTag(t) {
  return GENERIC_TAGS.has(t);
}

// Split tag into token parts, supporting underscore + hyphen
function splitTagTokens(tag = "") {
  return String(tag)
    .toLowerCase()
    .split(/[_-]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Expand a raw tag into multiple normalized tokens:
// "iran_missiles" -> ["iran","missile","iran_missile"]
function expandTag(raw = "") {
  const base = normalizeTag(raw);
  if (!base) return [];
  const parts = splitTagTokens(base);
  const expanded = [base, ...parts].map(stem).filter(Boolean);
  return expanded.filter((t) => !STOPWORDS.has(t) && t.length >= 3);
}

// Accept tags in multiple shapes and normalize them (base tokens only)
function normalizeArticleTags(input) {
  if (typeof input === "string") {
    return input
      .split(/[,|]/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .map(normStemTag)
      .filter(Boolean);
  }

  if (Array.isArray(input)) {
    return input
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object") return x.value || x.label || x.name || "";
        return "";
      })
      .map(normStemTag)
      .filter(Boolean);
  }

  return [];
}

// Heuristic: extract "entity-like" tokens from base article tags
// - non-generic
// - not stopword
// - not a typical event keyword
// - length >= 4 (filters short junk)
function extractEntityTokensFromBaseTags(baseArticleTags = []) {
  const base = Array.isArray(baseArticleTags) ? baseArticleTags : [];
  const out = base
    .map((t) => String(t || "").trim().toLowerCase())
    .map(stem)
    .filter(Boolean)
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !isGenericTag(t))
    .filter((t) => !NON_ENTITY_KEYWORDS.has(t));

  return dedupe(out);
}

// -----------------------------------------------------------------------------
// CLOUDINARY LOAD
// -----------------------------------------------------------------------------
async function loadCloudinaryCandidates(folder, limit) {
  const outMap = new Map();

  // We try multiple expressions because Cloudinary “folders” behave differently
  // depending on folder mode (fixed vs dynamic/DAM).
  const expressions = [
    // fixed folder mode: folder is part of public_id
    `resource_type:image AND type:upload AND public_id:${folder}/*`,
    // dynamic folder mode / DAM: folder stored in asset_folder
    `resource_type:image AND type:upload AND asset_folder:${folder}`,
    // fallback (some accounts expose folder field)
    `resource_type:image AND type:upload AND folder:${folder}`,
  ];

  async function runSearch(expression) {
    let nextCursor = null;

    while (outMap.size < limit) {
      const q = cloudinary.search
        .expression(expression)
        .sort_by("created_at", "desc")
        .max_results(Math.min(100, limit - outMap.size))
        .with_field("tags")
        .with_field("context");

      if (nextCursor) q.next_cursor(nextCursor);

      const res = await q.execute();

      for (const r of res.resources || []) {
        if (r?.public_id && !outMap.has(r.public_id)) outMap.set(r.public_id, r);
      }

      if (!res.next_cursor) break;
      nextCursor = res.next_cursor;
    }
  }

  // Run each expression until we have enough candidates
  for (const expr of expressions) {
    try {
      await runSearch(expr);
      if (outMap.size >= limit) break;
    } catch (e) {
      console.log("[imagePicker] Cloudinary search failed for expression", {
        expr,
        err: e?.message,
      });
    }
  }

  let out = Array.from(outMap.values());

  // Exclude disallowed prefixes (supports both folder style and naming style)
  out = out.filter((a) => {
    const pid = a?.public_id || "";
    return !EXCLUDE_PREFIXES.some((pref) => pid.startsWith(pref));
  });

  console.log("[imagePicker] Candidates loaded (Search API)", {
    folder,
    totalAfterFilter: out.length,
    excludedPrefixes: EXCLUDE_PREFIXES,
    sample: out
      .slice(0, 5)
      .map((x) => ({ public_id: x.public_id, tags: x.tags || [], context: x?.context?.custom || null })),
  });

  return out;
}

// -----------------------------------------------------------------------------
// ASSET HELPERS
// -----------------------------------------------------------------------------
function getAssetTags(asset) {
  // 1) PRIMARY: editorial tags stored in context metadata (reliable)
  const ctxCustom = asset?.context?.custom || {};
  const ctxTagsRaw = ctxCustom.article_tags || ctxCustom.tags || ctxCustom.keywords || "";

  const ctxTags = String(ctxTagsRaw || "")
    .split(/[,|]/g)
    .map((x) => x.trim())
    .filter(Boolean);

  // 2) SECONDARY: Cloudinary asset tags (often empty for auto-tags)
  const assetTags = Array.isArray(asset?.tags) ? asset.tags : [];

  const mergedRaw = dedupe([...ctxTags, ...assetTags]);

  // expand compound tags into tokens + normalize
  const expanded = mergedRaw.flatMap(expandTag);
  const base = mergedRaw.map(normStemTag).filter(Boolean);

  return dedupe([...expanded, ...base]);
}

function getAssetContextText(asset) {
  const ctx = asset?.context?.custom || {};
  return Object.values(ctx)
    .filter((v) => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

function getAssetIdText(asset) {
  return String(asset?.public_id || "").toLowerCase();
}

// -----------------------------------------------------------------------------
// SCORING (AFTER TAG FILTER)
// -----------------------------------------------------------------------------
function scoreAsset(asset, tokens) {
  const tags = getAssetTags(asset);
  const ctx = getAssetContextText(asset);
  const pid = getAssetIdText(asset);

  let score = 0;
  const matchedTags = [];
  const matchedContext = [];
  const matchedTokens = [];

  for (const t of tokens) {
    if (tags.includes(t)) {
      score += 8;
      matchedTags.push(t);
      continue;
    }
    if (ctx.includes(t)) {
      score += 4;
      matchedContext.push(t);
      continue;
    }
    if (pid.includes(t)) {
      score += 2;
      matchedTokens.push(t);
    }
  }

  if (dedupe(matchedTags).length >= 2) score += 3;

  return {
    score,
    matchedTags: dedupe(matchedTags),
    matchedContext: dedupe(matchedContext),
    matchedTokens: dedupe(matchedTokens),
  };
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
exports.chooseHeroImage = async function (meta = {}) {
  try {
    // base normalized tags
    const baseArticleTags = dedupe(normalizeArticleTags(meta.tags));

    if (!baseArticleTags.length) {
      console.log("[imagePicker] Article has no tags → skipping auto-pick");
      return null;
    }

    // expanded tokens used for matching
    const articleExpanded = dedupe(baseArticleTags.flatMap(expandTag));
    const articleExpandedSet = new Set(articleExpanded);

    // "specific" means NOT generic, computed on expanded tokens
    const specificTokens = articleExpanded.filter((t) => !isGenericTag(t));
    if (!specificTokens.length) {
      console.log("[imagePicker] Only generic tags → skipping auto-pick", {
        articleTags: baseArticleTags,
        expanded: articleExpanded,
      });
      return null;
    }

    // Tokens used for scoring (tag-driven)
    const tokens = dedupe(
      articleExpanded.map(stem).filter((t) => !STOPWORDS.has(t) && t.length >= 3)
    );

    // ✅ Multi-entity enforcement
    const entityTokens = extractEntityTokensFromBaseTags(baseArticleTags);
    const isMultiEntityStory = entityTokens.length >= 2;

    const candidates = await loadCloudinaryCandidates(CLOUDINARY_FOLDER, MAX_CANDIDATES);

    if (!candidates.length) {
      console.log("[imagePicker] No Cloudinary candidates loaded", {
        folder: CLOUDINARY_FOLDER,
        max: MAX_CANDIDATES,
      });
      return null;
    }

    // DEBUG: prove whether Cloudinary API is returning tags
    const withTags = candidates.filter((a) => Array.isArray(a?.tags) && a.tags.length > 0);

    console.log("[imagePicker] Candidate tag stats", {
      folder: CLOUDINARY_FOLDER,
      totalCandidates: candidates.length,
      candidatesWithAnyTags: withTags.length,
      sampleWithTags: withTags.slice(0, 5).map((a) => ({
        public_id: a.public_id,
        tags: a.tags,
      })),
      sampleNoTags: candidates.slice(0, 5).map((a) => ({
        public_id: a.public_id,
        tags: a.tags,
      })),
    });

    console.log("[imagePicker] Candidate context samples", {
      sampleContext: candidates.slice(0, 5).map((a) => ({
        public_id: a.public_id,
        context: a?.context?.custom || null,
      })),
    });

    // -----------------------------------------------------------------------
    // ✅ HARD RULE: require at least MIN_REQUIRED_TAG_MATCHES (default 3)
    // If we can't find images with >=3 expanded tag matches → return null
    // -----------------------------------------------------------------------
    const requiredMatches = Math.max(1, MIN_REQUIRED_TAG_MATCHES);

    function filterByRequired(required) {
      return candidates
        .map((asset) => {
          const assetTags = getAssetTags(asset);

          // count how many expanded article tokens appear in asset tags
          const matchedExpanded = assetTags.filter((t) => articleExpandedSet.has(t));
          const matchedSpecific = assetTags.filter(
            (t) => articleExpandedSet.has(t) && !isGenericTag(t)
          );

          return { asset, assetTags, matchedExpanded, matchedSpecific };
        })
        // must match at least 1 specific token to avoid "world-only" matches
        .filter((x) => x.matchedExpanded.length >= required && x.matchedSpecific.length >= 1);
    }

    const tagMatched = filterByRequired(requiredMatches);

    if (!tagMatched.length) {
      console.log(
        "[imagePicker] No Cloudinary images matched required tag count → returning null (default)",
        {
          folder: CLOUDINARY_FOLDER,
          articleTags: baseArticleTags,
          expanded: articleExpanded,
          requiredMatches,
          excludedPrefixes: EXCLUDE_PREFIXES,
          entityTokens,
          isMultiEntityStory,
        }
      );
      return null;
    }

    const usedRequiredMatches = requiredMatches;

    // SCORE ONLY TAG-MATCHED
    let best = null;

    for (const row of tagMatched) {
      const scored = scoreAsset(row.asset, tokens);

      const mergedMatchedTags = dedupe([
        ...(scored.matchedTags || []),
        ...(row.matchedExpanded || []),
      ]);

      let mergedScore =
        scored.score +
        row.matchedExpanded.length + // tiny bump per match
        row.matchedSpecific.length * 2; // reward specificity

      // 🔥 Multi-entity enforcement
      let entityMatchInfo = null;

      if (isMultiEntityStory) {
        const assetTags = row.assetTags || [];
        let matchedEntities = 0;

        for (const ent of entityTokens) {
          if (assetTags.includes(ent)) matchedEntities += 1;
        }

        const missing = entityTokens.length - matchedEntities;

        if (missing === 0) {
          mergedScore += 12; // big bonus if contains all entities
        } else {
          mergedScore -= missing * 8; // strong penalty per missing entity
        }

        entityMatchInfo = {
          entityTokens,
          matchedEntities,
          missingEntities: missing,
        };
      }

      const candidate = {
        asset: row.asset,
        score: mergedScore,
        matchedTags: mergedMatchedTags,
        matchedSpecificTags: dedupe(row.matchedSpecific || []),
        matchedContext: scored.matchedContext,
        matchedTokens: scored.matchedTokens,
        entityMatchInfo,
      };

      if (!best || candidate.score > best.score) best = candidate;
    }

    if (!best || best.score < MIN_SCORE) {
      console.log("[imagePicker] No strong tag-based image found", {
        bestScore: best?.score,
        minScore: MIN_SCORE,
        entityTokens,
        isMultiEntityStory,
        requiredMatchesUsed: usedRequiredMatches,
        candidateCount: tagMatched.length,
      });
      return null;
    }

    return {
      publicId: best.asset.public_id,
      url: best.asset.secure_url,
      why: {
        mode: "cloudinary-tag-first",
        folder: CLOUDINARY_FOLDER,
        articleTags: baseArticleTags,
        expandedTokens: articleExpanded,
        requiredMatchesUsed: usedRequiredMatches,

        matchedTags: best.matchedTags,
        matchedSpecificTags: best.matchedSpecificTags,
        matchedContext: best.matchedContext,
        matchedTokens: best.matchedTokens,
        score: best.score,
        candidateCount: tagMatched.length,

        isMultiEntityStory,
        entityTokens,
        entityMatchInfo: best.entityMatchInfo || null,
      },
    };
  } catch (err) {
    console.error("[imagePicker ERROR]", err);
    return null;
  }
};

// -----------------------------------------------------------------------------
// NEW: Return multiple best-matching candidate images (for admin cycling UI)
// -----------------------------------------------------------------------------
// Usage:
//   const r = await chooseHeroImageCandidates(meta, { limit: 12 });
//   r.candidates => [{ publicId, url, score, createdAt, matchedTags, matchedSpecificTags }]
//
exports.chooseHeroImageCandidates = async function (meta = {}, opts = {}) {
  try {
    const limit = Math.max(1, Math.min(50, Number(opts.limit || 12)));

    // base normalized tags
    const baseArticleTags = dedupe(normalizeArticleTags(meta.tags));

    if (!baseArticleTags.length) return { candidates: [], why: { reason: "no_tags" } };

    // expanded tokens used for matching
    const articleExpanded = dedupe(baseArticleTags.flatMap(expandTag));
    const articleExpandedSet = new Set(articleExpanded);

    // "specific" means NOT generic, computed on expanded tokens
    const specificTokens = articleExpanded.filter((t) => !isGenericTag(t));

    // If everything is generic → don't pick at all
    if (!specificTokens.length) {
      return {
        candidates: [],
        why: { reason: "only_generic_tags", articleTags: baseArticleTags, expandedTokens: articleExpanded },
      };
    }

    // Decide minimum required matches:
    // - Always enforce hard minimum from env (default 3)
    // - But if the article has fewer than that many meaningful tokens, clamp to available
    const meaningfulCount = Math.max(0, specificTokens.length);
    const requiredMatches = Math.max(
      1,
      Math.min(MIN_REQUIRED_TAG_MATCHES, meaningfulCount || MIN_REQUIRED_TAG_MATCHES)
    );

    // Detect multi-entity stories (2+ strong entity-like tokens)
    const entityTokens = getEntityTokens(articleExpanded);
    const isMultiEntityStory = entityTokens.length >= 2;

    // Fetch Cloudinary assets from the main folder (exclude prefixes)
    const assets = await listAssetsInFolder(CLOUDINARY_FOLDER, MAX_CANDIDATES);

    const filteredAssets = (assets || []).filter((a) => {
      const pid = a?.public_id || "";
      if (!pid) return false;

      for (const pref of EXCLUDE_PREFIXES) {
        if (pref && pid.startsWith(pref)) return false;
      }
      return true;
    });

    // Score candidates based on required tag matches
    const tokens = {
      baseArticleTags,
      articleExpanded,
      articleExpandedSet,
      specificTokens,
    };

    function filterByRequired(required) {
      return filteredAssets
        .map((asset) => {
          const assetTags = dedupe(normalizeAssetTags(asset?.tags || []));
          const matchedExpanded = articleExpanded.filter((t) => assetTags.includes(t));
          const matchedSpecific = specificTokens.filter((t) => assetTags.includes(t));
          return { asset, assetTags, matchedExpanded, matchedSpecific };
        })
        // must match at least required expanded AND at least 1 specific token
        .filter((x) => x.matchedExpanded.length >= required && x.matchedSpecific.length >= 1);
    }

    const tagMatched = filterByRequired(requiredMatches);

    if (!tagMatched.length) {
      return {
        candidates: [],
        why: {
          reason: "no_matches",
          folder: CLOUDINARY_FOLDER,
          articleTags: baseArticleTags,
          expandedTokens: articleExpanded,
          requiredMatchesUsed: requiredMatches,
          excludedPrefixes: EXCLUDE_PREFIXES,
          isMultiEntityStory,
          entityTokens,
        },
      };
    }

    const candidates = [];

    for (const row of tagMatched) {
      const scored = scoreAsset(row.asset, tokens);

      const mergedMatchedTags = dedupe([
        ...(scored.matchedTags || []),
        ...(row.matchedExpanded || []),
      ]);

      let mergedScore =
        scored.score +
        row.matchedExpanded.length + // tiny bump per match
        row.matchedSpecific.length * 2; // reward specificity

      // Multi-entity enforcement (same as chooseHeroImage)
      let entityMatchInfo = null;

      if (isMultiEntityStory) {
        const assetTags = row.assetTags || [];
        let matchedEntities = 0;

        for (const ent of entityTokens) {
          if (assetTags.includes(ent)) matchedEntities += 1;
        }

        const missing = entityTokens.length - matchedEntities;

        if (missing === 0) {
          mergedScore += 12;
        } else {
          mergedScore -= missing * 8;
        }

        entityMatchInfo = {
          entityTokens,
          matchedEntities,
          missingEntities: missing,
        };
      }

      candidates.push({
        publicId: row.asset.public_id,
        url: row.asset.secure_url,
        createdAt: row.asset.created_at || null,
        score: mergedScore,
        matchedTags: mergedMatchedTags,
        matchedSpecificTags: dedupe(row.matchedSpecific || []),
        entityMatchInfo,
      });
    }

    const strong = candidates
      .filter((c) => (c?.score ?? 0) >= MIN_SCORE)
      .sort((a, b) => {
        // primary: score desc
        const ds = (b.score || 0) - (a.score || 0);
        if (ds !== 0) return ds;

        // tie-break: newest first
        const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
        const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
        return tb - ta;
      })
      .slice(0, limit);

    return {
      candidates: strong,
      why: {
        mode: "cloudinary-tag-first",
        folder: CLOUDINARY_FOLDER,
        articleTags: baseArticleTags,
        expandedTokens: articleExpanded,
        requiredMatchesUsed: requiredMatches,
        candidateCount: tagMatched.length,
        returned: strong.length,
        isMultiEntityStory,
        entityTokens,
      },
    };
  } catch (err) {
    console.error("[imagePicker candidates ERROR]", err);
    return { candidates: [], why: { error: String(err) } };
  }
};


