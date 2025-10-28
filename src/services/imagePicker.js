// backend/src/services/imagePicker.js
const cloudinary = require("cloudinary").v2;
const slugify = require("slugify");

const FOLDER = process.env.AUTOMATION_IMAGE_FOLDER || "news-images";
const FALLBACK_ID = process.env.AUTOMATION_DEFAULT_IMAGE_ID || `${FOLDER}/default-hero`;

// ---- CONFIG TUNING ----
const OG_RATIO = 1200 / 630;       // ≈1.904
const RECENT_DAYS = 14;            // small recency boost window
const MAX_RESULTS = 150;           // how many assets to score

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

// very light stemming: plural -> singular, trailing punctuation
function stem(t) {
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";   // policies -> policy
  if (t.endsWith("s") && t.length > 3) return t.slice(0, -1); // rolls -> roll
  return t;
}

function ngrams(tokens, n) {
  const out = [];
  for (let i=0;i<=tokens.length - n;i++) out.push(tokens.slice(i,i+n).join(" "));
  return out;
}

function buildTokens({ title, summary, category, tags, slug }) {
  const raw = dedupe(tokenize(`${title} ${summary} ${slug || ""}`)).map(stem)
    .filter(t => !STOPWORDS.has(t) && t.length >= 3);

  // add category & tags
  if (category) raw.push(...tokenize(category).map(stem));
  (tags || []).map(String).forEach(t => raw.push(...tokenize(t).map(stem)));

  const tokens = dedupe(raw);

  // auto-phrases from title (bigrams + trigrams)
  const titleToks = tokenize(title).map(stem).filter(t => !STOPWORDS.has(t));
  const phrases = dedupe([
    ...ngrams(titleToks, 3),
    ...ngrams(titleToks, 2),
    // hard-coded helpful phrases:
    "election commission","supreme court","lok sabha","union budget","defence minister"
  ]).filter(p => p.split(" ").length >= 2);

  return { tokens, phrases };
}

function bm25ishScore(name, tokens) {
  // simple tf weighting by presence and term length (favor rarer/longer-ish)
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
  if (days <= RECENT_DAYS) return 1;
  return 0;
}

function negativePenalty(name, articleStrongNames) {
  // if filename contains a strong proper name not present in article context -> penalize
  for (const neg of ["modi","rahul","rajnath","ambani","adani","ambani","musk","trump","biden"]) {
    if (name.includes(neg) && !articleStrongNames.some(s => neg.includes(s) || s.includes(neg))) {
      return -3;
    }
  }
  return 0;
}

function strongNamesFrom(title, summary) {
  // super-rough: pick capitalized words (when provided) or known last names from filename context
  // but we operate on lowercase here, so extract from tokens:
  const toks = tokenize(`${title} ${summary}`);
  return dedupe(toks.filter(t => /^(modi|rahul|rajnath|singh|gandhi|ambani|adani|shah|yogi|kejriwal)$/.test(t)));
}

function scoreCandidate(cand, tokens, phrases, articleStrongNames) {
  const id = cand.public_id;
  const name = id.split("/").pop().toLowerCase(); // filename part

  let score = 0;

  // phrase priority: exact hyphenated / plain
  for (const p of phrases) {
    const plain = p.replace(/\s+/g, "");
    const hyph = p.replace(/\s+/g, "-");
    if (name.includes(hyph) || name.includes(plain) || name.includes(p)) score += 7;
  }

  // BM25-ish on tokens
  score += bm25ishScore(name, tokens);

  // multiple matches bonus
  const matchedTokens = tokens.filter(t => t.length>=3 && name.includes(t));
  if (matchedTokens.length >= 2) score += 2;

  // image quality/shape
  score += ratioScore(cand.width, cand.height);
  if (cand.width >= 1000) score += 1;
  if (cand.height >= 600) score += 1;

  // recency helps
  score += recencyScore(cand.created_at || cand.uploaded_at);

  // unrelated famous-name penalty
  score += negativePenalty(name, articleStrongNames);

  return { score, matchedTokens: matchedTokens.slice(0,5) };
}

async function searchFolder(expression) {
  const res = await cloudinary.search
    .expression(expression)
    .with_field("context")
    .sort_by("public_id","asc")
    .max_results(MAX_RESULTS)
    .execute();
  return (res && res.resources) || [];
}

// Public: chooseHeroImage({ title, summary, category, tags, slug })
exports.chooseHeroImage = async function chooseHeroImage(meta = {}) {
  try {
    const articleSlug =
      meta.slug ||
      slugify(meta.title || "article", { lower: true, strict: true });

    const { tokens, phrases } = buildTokens({
      title: meta.title || "",
      summary: meta.summary || "",
      category: meta.category || "",
      tags: meta.tags || [],
      slug: articleSlug,
    });

    const strongNames = strongNamesFrom(meta.title || "", meta.summary || "");

    // ---- 0) exact slug fast-path
    const exactId = `${FOLDER}/${articleSlug}`;
    const exact = await searchFolder(`public_id="${exactId}"`);
    if (exact.length) {
      const url = cloudinary.url(exactId, {
        type: "upload",
        transformation: [
          { width: 1200, height: 630, crop: "fill", gravity: "auto" },
          { fetch_format: "jpg", quality: "auto" },
        ],
        secure: true,
      });
      return { publicId: exactId, url, why: { mode: "exact-slug" } };
    }

    // ---- 1) build a rich search expression (filename + tags + context)
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
      const list = await cloudinary.api.resources({
        type: "upload",
        prefix: `${FOLDER}/`,
        max_results: MAX_RESULTS
      });
      candidates = list.resources || [];
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
        if ((matchedTokens?.length||0) > (best.matchedTokens?.length||0)) {
          best = pack;
        } else {
          const ra = ratioScore(best.cand.width, best.cand.height);
          const rb = ratioScore(cand.width, cand.height);
          if (rb > ra) {
            best = pack;
          } else if (rb === ra) {
            const a = best.cand.public_id.split("/").pop();
            const b = cand.public_id.split("/").pop();
            const extraA = a.replace(/-/g," ").split(/\s+/).length - (best.matchedTokens?.length||0);
            const extraB = b.replace(/-/g," ").split(/\s+/).length - (matchedTokens?.length||0);
            if (extraB < extraA) best = pack;
          }
        }
      }
    }

    const chosen = best?.cand || null;
    const publicId = chosen ? chosen.public_id : FALLBACK_ID;

    const url = cloudinary.url(publicId, {
      type: "upload",
      transformation: [
        { width: 1200, height: 630, crop: "fill", gravity: "auto" },
        { fetch_format: "jpg", quality: "auto" },
      ],
      secure: true,
    });

    // You can log `why` during testing and remove later
    const why = chosen ? {
      mode: "scored",
      score: best.score,
      matchedTokens: best.matchedTokens,
      width: chosen.width, height: chosen.height,
      id: chosen.public_id
    } : { mode: "fallback" };

    return { publicId, url, why };
  } catch (e) {
    const url = cloudinary.url(FALLBACK_ID, {
      type: "upload",
      transformation: [
        { width: 1200, height: 630, crop: "fill", gravity: "auto" },
        { fetch_format: "jpg", quality: "auto" },
      ],
      secure: true,
    });
    return { publicId: FALLBACK_ID, url, why: { mode: "error", error: String(e) } };
  }
};
 