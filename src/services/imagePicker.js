// -----------------------------------------------------------------------------
// imagePicker.js  (Google Drive → Cloudinary Hybrid Auto-Image System)
// CLEANED VERSION: never returns default image; only real Drive picks or null
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { v2: cloudinary } = require("cloudinary");
const Article = require("../models/Article");
const { getDriveClient } = require("./driveClient");

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
const DRIVE_FOLDER_ID =
  process.env.GOOGLE_DRIVE_NEWS_FOLDER_ID ||
  process.env.GOOGLE_DRIVE_FOLDER_ID;

const TEMP_DIR = path.join(__dirname, "../../tmp-drive-images");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const { drive, credSource } = getDriveClient();

// -----------------------------------------------------------------------------
// TEXT UTILS
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
  "minister",
  "ministry",
  "govt",
  "government"
  // ❌ REMOVED: india, indian, country
]);

function tokenize(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/g)
    .filter(Boolean);
}

function dedupe(a) {
  return Array.from(new Set(a));
}

function stem(t) {
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.endsWith("s") && t.length > 3) return t.slice(0, -1);
  return t;
}

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

// -----------------------------------------------------------------------------
// STRONG NAMES (leaders)
// -----------------------------------------------------------------------------
function strongNamesFrom(title, summary) {
  const toks = tokenize(`${title} ${summary}`);

  return dedupe(
    toks.filter((t) =>
      /^(modi|rahul|rajnath|gandhi|singh|ambani|adani|shah|yogi|kejriwal|trump|biden|musk|putin|vladimir|xi|jinping|zelensky|netanyahu|sunak|scholz|macron)$/.test(
        t
      )
    )
  );
}

// All strong-name tokens we care about for filtering filenames
const ALL_STRONG_NAME_TOKENS = [
  "modi",
  "rahul",
  "rajnath",
  "gandhi",
  "singh",
  "ambani",
  "adani",
  "shah",
  "yogi",
  "kejriwal",
  "trump",
  "biden",
  "musk",
  "putin",
  "vladimir",
  "xi",
  "jinping",
  "zelensky",
  "netanyahu",
  "sunak",
  "scholz",
  "macron"
];

// Returns true if filename contains some *other* strong leader name
// that is NOT part of the article strongNames list.
function containsOtherStrongName(fileNameLower, articleStrongNames) {
  const allowed = new Set(
    (articleStrongNames || []).map((s) => String(s).toLowerCase())
  );

  for (const token of ALL_STRONG_NAME_TOKENS) {
    if (!fileNameLower.includes(token)) continue;
    if (!allowed.has(token)) {
      // file has a strong leader who is not in this article
      return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// BRAND / INSTITUTION STRONG TOKENS (IndiGo, RBI, GDP, Market, etc.)
// -----------------------------------------------------------------------------
const BRAND_STRONG_TOKENS = new Set([
  // Airlines
  "indigo",
  "airindia",
  "vistara",
  "spicejet",
  "akasa",
  "goair",
  "airasia",

  // Financial / markets / regulators
  "rbi",
  "sebi",
  "sensex",
  "nifty",
  "gdp",
  "bse",
  "nse",
  "stock",
  "market",
  "markets",

  // Institutions
  "isro",
  "drdo",
  "railway",
  "railways",
  "indianrailways"
]);


function strongBrandsFrom(meta) {
  const src = `${meta.title || ""} ${meta.summary || ""} ${
    meta.slug || ""
  } ${(meta.tags || []).join(" ")}`;
  const toks = tokenize(src);
  return dedupe(toks.filter((t) => BRAND_STRONG_TOKENS.has(t)));
}

// -----------------------------------------------------------------------------
// GENERIC TOKENS WE DON'T WANT IN DRIVE QUERY (but still score on)
// -----------------------------------------------------------------------------
const GENERIC_QUERY_TOKENS = new Set([
  "india",
  "indian",
  "global",
  "world",
  "summit",
  "meeting",
  "talks",
  "ties",
  "relation",
  "relations",
  "growth",
  "economy",
  "economic",
  "market",
  "markets",
  "business",
  "policy",
  "reform",
  "update",
  "latest",
  "breaking",
  "event",
  "news"
]);

// -----------------------------------------------------------------------------
// NEGATIVE PENALTY
// -----------------------------------------------------------------------------
function negativePenalty(name, strong) {
  const famous = [
    "modi",
    "rahul",
    "rajnath",
    "gandhi",
    "singh",
    "ambani",
    "adani",
    "shah",
    "yogi",
    "kejriwal",
    "trump",
    "biden",
    "musk"
  ];

  for (const f of famous) {
    if (name.includes(f) && !strong.includes(f)) return -3;
  }
  return 0;
}

// -----------------------------------------------------------------------------
// TOKEN / PHRASE BUILDER
// -----------------------------------------------------------------------------
function buildTokens(meta) {
  const raw = dedupe(
    tokenize(`${meta.title || ""} ${meta.summary || ""} ${meta.slug || ""}`)
  )
    .map(stem)
    .filter((t) => !STOPWORDS.has(t) && t.length >= 3);

  if (meta.category) {
    raw.push(...tokenize(meta.category).map((t) => stem(t)));
  }

  (meta.tags || []).forEach((t) =>
    raw.push(...tokenize(String(t)).map((x) => stem(x)))
  );

  const tokens = dedupe(raw);

  const titleToks = tokenize(meta.title || "")
    .map(stem)
    .filter((t) => !STOPWORDS.has(t));

  // Base phrases from the actual title
  const basePhrases = [
    ...ngrams(titleToks, 3),
    ...ngrams(titleToks, 2)
  ];

  // Extra hard-coded phrases ONLY if they actually appear in text
  const extraPhrases = [];
  const textLower = `${meta.title || ""} ${meta.summary || ""}`.toLowerCase();

  if (textLower.includes("election commission")) {
    extraPhrases.push("election commission");
  }
  if (textLower.includes("supreme court")) {
    extraPhrases.push("supreme court");
  }
  if (textLower.includes("lok sabha")) {
    extraPhrases.push("lok sabha");
  }
  if (textLower.includes("union budget")) {
    extraPhrases.push("union budget");
  }
  if (textLower.includes("defence minister")) {
    extraPhrases.push("defence minister");
  }

  const phrases = dedupe([...basePhrases, ...extraPhrases]);

  return { tokens, phrases };
}

// -----------------------------------------------------------------------------
// SEARCH GOOGLE DRIVE
// -----------------------------------------------------------------------------
async function searchDriveCandidates(tokens = [], phrases = []) {
  if (!drive) return [];

  const qParts = [];

  for (const t of tokens) {
    if (t.length < 3) continue;
    // Don’t use super-generic words to build the Drive query
    if (GENERIC_QUERY_TOKENS.has(t)) continue;
    qParts.push(`name contains '${t}'`);
  }

  for (const p of phrases) {
    const plain = p.replace(/\s+/g, "");
    const hyph = p.replace(/\s+/g, "-");
    qParts.push(`name contains '${plain}'`);
    qParts.push(`name contains '${hyph}'`);
  }

  // Always filter to images only
  const baseFilter = `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/'`;

  const query = qParts.length
    ? `${baseFilter} and (${qParts.join(" or ")})`
    : baseFilter;

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name, mimeType, modifiedTime)",
    pageSize: 100
  });

  return res.data.files || [];
}

// -----------------------------------------------------------------------------
// SCORING ENGINE (IMPROVED + BRANDS + RECENCY)
// -----------------------------------------------------------------------------
function scoreFile(f, tokens, phrases, strongNames, strongBrands) {
  const name = f.name.toLowerCase();
  let score = 0;

  // Phrase match — strongest
  for (const p of phrases) {
    const plain = p.replace(/\s+/g, "");
    const hyph = p.replace(/\s+/g, "-");
    if (name.includes(plain) || name.includes(hyph) || name.includes(p)) {
      score += 7;
    }
  }

  // Strong-name BOOST (leaders)
  for (const s of strongNames) {
    if (name.includes(s)) score += 10;
  }

  // Brand / institution BOOST
  for (const b of strongBrands) {
    if (name.includes(b)) score += 8;
  }

  // Token scoring with downweights
  for (const t of tokens) {
    if (["energy", "oil", "gas", "geopolitic", "defence", "security"].includes(t)) {
      if (name.includes(t)) score += 1; // generic topics → weak
      continue;
    }

    if (name.includes(t)) score += 2;
  }

  const matchedTokens = tokens.filter((t) => name.includes(t));
  if (matchedTokens.length >= 2) score += 2;

  score += negativePenalty(name, strongNames);

  // Recency bias using modifiedTime
  if (f.modifiedTime) {
    const now = Date.now();
    const modifiedMs = new Date(f.modifiedTime).getTime();
    if (!Number.isNaN(modifiedMs)) {
      const ageMs = now - modifiedMs;
      const sixMonths = 180 * 24 * 60 * 60 * 1000;
      const twoYears = 730 * 24 * 60 * 60 * 1000;

      if (ageMs <= sixMonths) {
        score += 2; // very recent
      } else if (ageMs <= twoYears) {
        score += 1; // moderately recent
      } else {
        // very old: no bonus (or small penalty later if needed)
      }
    }
  }

  return { score, matchedTokens };
}

// -----------------------------------------------------------------------------
// DOWNLOAD → CLOUDINARY
// -----------------------------------------------------------------------------
async function downloadAndUploadToCloudinary(file) {
  const destPath = path.join(TEMP_DIR, `${file.id}-${file.name}`);
  const dest = fs.createWriteStream(destPath);

  await drive.files
    .get({ fileId: file.id, alt: "media" }, { responseType: "stream" })
    .then((res) => {
      return new Promise((resolve, reject) => {
        res.data.on("end", resolve).on("error", reject).pipe(dest);
      });
    });

  const uploaded = await cloudinary.uploader.upload(destPath, {
    folder: process.env.CLOUDINARY_FOLDER
      ? `${process.env.CLOUDINARY_FOLDER}/google`
      : "news-images/google",
    resource_type: "image"
  });

  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  } catch (err) {
    console.warn("[imagePicker] cleanup warning:", err);
  }

  return {
    publicId: uploaded.public_id,
    url: uploaded.secure_url
  };
}

// -----------------------------------------------------------------------------
// PERSON ROTATION
// -----------------------------------------------------------------------------
async function pickRotatedPersonFile(personKey, candidates) {
  if (!personKey || !Array.isArray(candidates) || !candidates.length) {
    return null;
  }

  const regex = new RegExp(personKey, "i");

  let usedCount = 0;
  try {
    const conn = Article.db;
    const isReady = conn && conn.readyState === 1;

    if (isReady) {
      usedCount = await Article.countDocuments({
        $or: [{ title: regex }, { summary: regex }]
      });
    } else {
      usedCount = 0;
    }
  } catch (err) {
    usedCount = 0;
  }

  const sorted = [...candidates].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );

  const index = usedCount % sorted.length;
  const chosen = sorted[index];

  return {
    file: chosen,
    meta: {
      mode: "drive-picked-rotated",
      personKey,
      usedCount,
      poolSize: sorted.length,
      pickedIndex: index
    }
  };
}

// -----------------------------------------------------------------------------
// MAIN EXPORT
// -----------------------------------------------------------------------------
exports.chooseHeroImage = async function (meta = {}) {
  try {
    // If Drive is not configured, tell caller "no pick"
    if (!DRIVE_FOLDER_ID) {
      console.warn("[imagePicker] No DRIVE_FOLDER_ID configured");
      return null;
    }

    if (!drive) {
      console.warn("[imagePicker] No Drive client available; credSource =", credSource);
      return null;
    }

    const { tokens, phrases } = buildTokens(meta);
    const strongNames = strongNamesFrom(meta.title || "", meta.summary || "");
    const strongBrands = strongBrandsFrom(meta);

    let candidates = await searchDriveCandidates(tokens, phrases);

    // Fallback list-all when query returns nothing
    if (!candidates.length) {
      const res = await drive.files.list({
        q: `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/'`,
        fields: "files(id, name, mimeType, modifiedTime)",
        pageSize: 50
      });
      candidates = res.data.files || [];
    }

    if (!candidates.length) {
      console.log("[imagePicker] No Drive files found in folder:", DRIVE_FOLDER_ID);
      return null;
    }

    let best = null;
    let rotationMeta = null;

    // Person rotation: if a strongName (e.g. modi/putin) exists,
    // try to rotate across all matching files first,
    // but avoid images that contain OTHER leaders not in this article.
    const personKey = strongNames.length ? strongNames[0] : null;
    if (personKey) {
      const lower = personKey.toLowerCase();

      const personCandidates = candidates.filter((f) => {
        const fname = f.name.toLowerCase();

        // Must contain this personKey (e.g. "modi")
        if (!fname.includes(lower)) return false;

        // If filename also contains some OTHER strong-name token
        // that is not in article strongNames, skip it.
        if (containsOtherStrongName(fname, strongNames)) {
          return false;
        }

        return true;
      });

      if (personCandidates.length > 0) {
        const rotated = await pickRotatedPersonFile(personKey, personCandidates);
        if (rotated && rotated.file) {
          best = { file: rotated.file, score: null, matchedTokens: [] };
          rotationMeta = rotated.meta;
        }
      }
    }

    // Standard scoring (if rotation didn't already choose)
    if (!best) {
      for (const f of candidates) {
        const pack = scoreFile(f, tokens, phrases, strongNames, strongBrands);
        const scored = {
          file: f,
          score: pack.score,
          matchedTokens: pack.matchedTokens
        };

        if (!best || scored.score > best.score) {
          best = scored;
        }
      }
    }

    // If somehow no usable candidate → no pick
    if (!best || !best.file) {
      console.log("[imagePicker] No best candidate after scoring");
      return null;
    }

    // ─────────────────────────────────────────────────────────────
    // CONFIDENCE GATE:
    // Only trust Drive pick if score is high enough and we have
    // at least some meaningful token signal. Otherwise return null
    // and let the caller (imageStrategy) fall back to default hero.
    // ─────────────────────────────────────────────────────────────
    if (best.score != null && typeof best.score === "number") {
      const filenameLower = best.file.name.toLowerCase();

      const hasStrongNameHit = Array.isArray(strongNames)
        ? strongNames.some((s) =>
            filenameLower.includes(String(s).toLowerCase())
          )
        : false;

      const hasBrandHit = Array.isArray(strongBrands)
        ? strongBrands.some((b) =>
            filenameLower.includes(String(b).toLowerCase())
          )
        : false;

      const matchedTokenCount = Array.isArray(best.matchedTokens)
        ? best.matchedTokens.length
        : 0;

      const articleHasStrongName = strongNames.length > 0;
      const articleHasStrongBrand = strongBrands.length > 0;

      // Base thresholds
      const MIN_SCORE_WITH_KEY = 5; // filename hits a leader or brand
      const MIN_SCORE_WITHOUT_KEY = 8;
      const MIN_SCORE_GENERIC = 10;

      let minScore;

      if (!articleHasStrongName && !articleHasStrongBrand) {
        // Completely generic article: be extra strict
        minScore = MIN_SCORE_GENERIC;
        if (best.score < minScore || matchedTokenCount < 2) {
          console.log("[imagePicker] Rejecting generic low-confidence candidate", {
            file: best.file.name,
            score: best.score,
            minScore,
            matchedTokenCount,
            strongNames,
            strongBrands
          });
          return null;
        }
      } else {
        // Article has either leader or brand context
        if (hasStrongNameHit || hasBrandHit) {
          minScore = MIN_SCORE_WITH_KEY;
        } else {
          minScore = MIN_SCORE_WITHOUT_KEY;
        }

        if (best.score < minScore || matchedTokenCount === 0) {
          console.log("[imagePicker] Rejecting low-confidence candidate", {
            file: best.file.name,
            score: best.score,
            minScore,
            matchedTokenCount,
            strongNames,
            strongBrands
          });
          return null;
        }
      }
    }

    const uploaded = await downloadAndUploadToCloudinary(best.file);

    return {
      publicId: uploaded.publicId,
      url: uploaded.url,
      why: {
        mode: rotationMeta ? rotationMeta.mode : "drive-picked",
        file: best.file.name,
        score: best.score,
        matchedTokens: best.matchedTokens,
        rotation: rotationMeta || null,
        credSource
      }
    };
  } catch (err) {
    console.error("[imagePicker ERROR]", err);
    // Tell caller "no pick"; caller can decide default image.
    return null;
  }
};
