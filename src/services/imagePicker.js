// backend/src/services/imagePicker.js
// Robust Cloudinary image picker for news articles.
// Returns { publicId, url, why } with deterministic fallbacks.

const { v2: cloudinary } = require("cloudinary");
const slugify = require("slugify");

// ---------- CONFIG ----------
const FOLDER = process.env.AUTOMATION_IMAGE_FOLDER || "news-images";
const FALLBACK_ID =
  process.env.AUTOMATION_DEFAULT_IMAGE_ID ||
  process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID ||
  `${FOLDER}/default-hero`;

const OG_W = 1200;
const OG_H = 630;
const OG_RATIO = OG_W / OG_H;        // ≈1.904
const RECENT_DAYS = 14;              // recency boost window
const MAX_RESULTS = 150;             // cap results we score (search + fallback list)
const PAGE_SIZE = 100;               // pagination size for API list fallback
const DEBUG = (process.env.IMAGE_PICKER_DEBUG || "false").toLowerCase() === "true";

// ---------- CLOUDINARY SAFE CONFIG ----------
(function ensureCloudinaryConfigured() {
  const cfg = cloudinary.config();
  if (!cfg.cloud_name) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
})();

// ---------- TEXT UTILS ----------
const STOPWORDS = new Set([
  "the","a","an","of","for","to","on","in","by","at","as","and","or","but","is","are","was","were",
  "be","been","being","from","with","over","under","into","out","new","latest","says","said","report",
  "minister","ministry","govt","government","india","indian","country"
]);

function tokenize(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}
function dedupe(arr) { return Array.from(new Set(arr)); }

// very light stemming
function stem(t) {
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";   // policies -> policy
  if (t.endsWith("s") && t.length > 3) return t.slice(0, -1); // rolls -> roll
  return t;
}
function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

function buildTokens({ title, summary, category, tags, slug }) {
  const raw = dedupe(tokenize(`${title} ${summary} ${slug || ""}`))
    .map(stem)
    .filter(t => !STOPWORDS.has(t) && t.length >= 3);

  if (category) raw.push(...tokenize(category).map(stem));
  (tags || []).map(String).forEach(t => raw.push(...tokenize(t).map(stem)));

  const tokens = dedupe(raw);


    // --- Minimal synonym expansion to align tokens with your media library ---
  // If editors type "IPL" or "T20" (or just choose category sports),
  // we also search for "cricket" so cricket images get scored higher.
  {
    const set = new Set(tokens);
    const add = w => { if (!set.has(w)) { tokens.push(w); set.add(w); } };

    if (set.has("ipl") || set.has("t20")) add("cricket");
    if (set.has("sports")) add("cricket");
    // You can extend later: "football" -> "soccer", etc.
  }



  // auto-phrases from title (bigrams + trigrams)
  const titleToks = tokenize(title).map(stem).filter(t => !STOPWORDS.has(t));
  const phrases = dedupe([
    ...ngrams(titleToks, 3),
    ...ngrams(titleToks, 2),
    // helpful fixed phrases
    "election commission","supreme court","lok sabha","union budget","defence minister"
  ]).filter(p => p.split(" ").length >= 2);

  if (tokens.includes("cricket")) {
    // Small phrase nudge so "cricket-stadium-01" wins ties
    phrases.push("cricket stadium", "ipl final", "t20");
  }

  return { tokens, phrases };
}

function bm25ishScore(name, tokens) {
  let s = 0;
  for (const t of tokens) {
    if (!t || t.length < 3) continue;
    if (name.includes(t)) s += Math.min(3, 1 + Math.log(t.length)); // 1..~3
  }
  return s;
}

function ratioScore(w, h) {
  if (!w || !h) return 0;
  const r = w / h;
  const diff = Math.abs(r - OG_RATIO);
  if (diff < 0.05) return 2;     // near-perfect
  if (diff < 0.15) return 1;     // acceptable
  return 0;
}

function recencyScore(uploadedAt) {
  if (!uploadedAt) return 0;
  const days = (Date.now() - new Date(uploadedAt).getTime()) / 86400000;
  return days <= RECENT_DAYS ? 1 : 0;
}

function strongNamesFrom(title, summary) {
  const toks = tokenize(`${title} ${summary}`);
  return dedupe(
    toks.filter(t =>
      /^(modi|rahul|rajnath|singh|gandhi|ambani|adani|shah|yogi|kejriwal|trump|biden|musk)$/.test(t)
    )
  );
}

function negativePenalty(name, articleStrongNames) {
  // penalize if file contains a strong proper name NOT present in article context
  for (const neg of ["modi","rahul","rajnath","ambani","adani","musk","trump","biden","gandhi","singh","shah","yogi","kejriwal"]) {
    if (name.includes(neg) && !articleStrongNames.some(s => neg.includes(s) || s.includes(neg))) {
      return -3;
    }
  }
  return 0;
}

function scoreCandidate(cand, tokens, phrases, articleStrongNames) {
  const id = cand.public_id;
  const name = id.split("/").pop().toLowerCase(); // filename

  let score = 0;

  // phrase priority: exact hyphenated / plain / spaced
  for (const p of phrases) {
    const plain = p.replace(/\s+/g, "");
    const hyph = p.replace(/\s+/g, "-");
    if (name.includes(hyph) || name.includes(plain) || name.includes(p)) score += 7;
  }

  // BM25-ish tokens
  score += bm25ishScore(name, tokens);

  // multiple matches bonus
  const matchedTokens = tokens.filter(t => t.length >= 3 && name.includes(t));
  if (matchedTokens.length >= 2) score += 2;

  // image quality/shape
  score += ratioScore(cand.width, cand.height);
  if (cand.width >= 1000) score += 1;
  if (cand.height >= 600) score += 1;

  // recency
  score += recencyScore(cand.created_at || cand.uploaded_at);

  // unrelated famous-name penalty
  score += negativePenalty(name, articleStrongNames);

  return { score, matchedTokens: matchedTokens.slice(0, 5) };
}

// ---------- CLOUDINARY QUERIES ----------
async function searchFolder(expression) {
  try {
    const res = await cloudinary.search
      .expression(expression)
      .with_field("context")
      .with_field("tags")
      .sort_by("public_id", "asc")
      .max_results(MAX_RESULTS)
      .execute();
    return (res && res.resources) || [];
  } catch (err) {
    if (DEBUG) console.warn("[imagePicker] search error, will fall back:", err?.message || err);
    return [];
  }
}

// Fallback listing via Admin API — handles pagination up to MAX_RESULTS
async function listFolderPrefix(prefix) {
  let out = [];
  let next_cursor = undefined;

  try {
    do {
      const res = await cloudinary.api.resources({
        type: "upload",
        prefix,
        max_results: Math.min(PAGE_SIZE, MAX_RESULTS - out.length),
        next_cursor,
      });
      out.push(...(res.resources || []));
      next_cursor = res.next_cursor;
    } while (next_cursor && out.length < MAX_RESULTS);
  } catch (err) {
    if (DEBUG) console.warn("[imagePicker] api.resources error:", err?.message || err);
  }

  return out;
}

// ---------- PUBLIC API ----------
/**
 * chooseHeroImage({ title, summary, category, tags, slug })
 * Returns { publicId, url, why }
 */
exports.chooseHeroImage = async function chooseHeroImage(meta = {}) {
  try {
    const norm = {
      title: meta.title || "",
      summary: meta.summary || "",
      category: meta.category || "",
      tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
      slug:
        meta.slug ||
        slugify(meta.title || "article", { lower: true, strict: true }),
    };

    const { tokens, phrases } = buildTokens(norm);
    const strongNames = strongNamesFrom(norm.title, norm.summary);

    // ---- 0) exact slug fast-path
    const exactId = `${FOLDER}/${norm.slug}`;
    const exact = await searchFolder(`public_id="${exactId}"`);
    if (exact.length) {
      const url = cloudinary.url(exactId, {
        type: "upload",
        transformation: [
          { width: OG_W, height: OG_H, crop: "fill", gravity: "auto" },
          { fetch_format: "jpg", quality: "auto" },
        ],
        secure: true,
      });
      if (DEBUG) console.log("[imagePicker] exact-slug hit:", exactId);
      return { publicId: exactId, url, why: { mode: "exact-slug" } };
    }

    // ---- 1) rich search expression
    const parts = [];
    for (const t of tokens) {
      if (t.length < 3) continue;
      parts.push(`filename:${t}`, `tags=${t}`, `context=*${t}*`);
    }
    for (const p of phrases) {
      const hyph = p.replace(/\s+/g, "-");
      const plain = p.replace(/\s+/g, "");
      parts.push(`filename:${hyph}`, `filename:${plain}`, `context=*${p}*`);
    }
    const term = parts.length ? `(${parts.join(" OR ")})` : "";
    const expr = term ? `folder:${FOLDER} AND ${term}` : `folder:${FOLDER}`;

    let candidates = await searchFolder(expr);

    // ---- 2) fallback to folder list if search gives nothing
    if (!candidates.length) {
      if (DEBUG) console.log("[imagePicker] search empty, listing prefix:", `${FOLDER}/`);
      candidates = await listFolderPrefix(`${FOLDER}/`);
    }

    // No assets at all → fallback immediately
    if (!candidates.length) {
      if (DEBUG) console.log("[imagePicker] no candidates found, using FALLBACK:", FALLBACK_ID);
      const url = cloudinary.url(FALLBACK_ID, {
        type: "upload",
        transformation: [
          { width: OG_W, height: OG_H, crop: "fill", gravity: "auto" },
          { fetch_format: "jpg", quality: "auto" },
        ],
        secure: true,
      });
      return { publicId: FALLBACK_ID, url, why: { mode: "no-candidates" } };
    }

    // ---- 3) score & choose
    let best = null;
    for (const cand of candidates) {
      const { score, matchedTokens } = scoreCandidate(cand, tokens, phrases, strongNames);
      const pack = { cand, score, matchedTokens };

      if (!best || score > best.score) {
        best = pack;
      } else if (best && score === best.score) {
        // tie-break: more matched tokens -> closer aspect -> fewer extra words
        const ra = ratioScore(best.cand.width, best.cand.height);
        const rb = ratioScore(cand.width, cand.height);
        const mtA = best.matchedTokens?.length || 0;
        const mtB = matchedTokens?.length || 0;

        if (mtB > mtA) best = pack;
        else if (rb > ra) best = pack;
        else if (rb === ra) {
          const a = best.cand.public_id.split("/").pop();
          const b = cand.public_id.split("/").pop();
          const extraA = a.replace(/-/g, " ").split(/\s+/).length - mtA;
          const extraB = b.replace(/-/g, " ").split(/\s+/).length - mtB;
          if (extraB < extraA) best = pack;
        }
      }
    }

    const chosen = best?.cand || null;
    const publicId = chosen ? chosen.public_id : FALLBACK_ID;

    const url = cloudinary.url(publicId, {
      type: "upload",
      transformation: [
        { width: OG_W, height: OG_H, crop: "fill", gravity: "auto" },
        { fetch_format: "jpg", quality: "auto" },
      ],
      secure: true,
    });

    const why = chosen
      ? {
          mode: "scored",
          score: best.score,
          matchedTokens: best.matchedTokens,
          width: chosen.width,
          height: chosen.height,
          id: chosen.public_id,
        }
      : { mode: "fallback" };

    if (DEBUG) console.log("[imagePicker] chosen:", why);

    return { publicId, url, why };
  } catch (e) {
    if (DEBUG) console.error("[imagePicker] error:", e);
    const url = cloudinary.url(FALLBACK_ID, {
      type: "upload",
      transformation: [
        { width: OG_W, height: OG_H, crop: "fill", gravity: "auto" },
        { fetch_format: "jpg", quality: "auto" },
      ],
      secure: true,
    });
    return { publicId: FALLBACK_ID, url, why: { mode: "error", error: String(e) } };
  }
};
