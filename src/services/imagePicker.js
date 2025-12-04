// -----------------------------------------------------------------------------
// imagePicker.js  (Google Drive → Cloudinary Hybrid Auto-Image System)
// FIXED + IMPROVED VERSION
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
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
  secure: true,
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
  "government",
  // ❌ REMOVED: india, indian, country
]);

function tokenize(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
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
// STRONG NAMES (expanded)
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
    "musk",
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
  const raw = dedupe(tokenize(`${meta.title} ${meta.summary} ${meta.slug}`))
    .map(stem)
    .filter((t) => !STOPWORDS.has(t) && t.length >= 3);

  if (meta.category) {
    raw.push(...tokenize(meta.category).map((t) => stem(t)));
  }

  (meta.tags || []).forEach((t) =>
    raw.push(...tokenize(String(t)).map((x) => stem(x)))
  );

  const tokens = dedupe(raw);

  const titleToks = tokenize(meta.title)
    .map(stem)
    .filter((t) => !STOPWORDS.has(t));

  const phrases = dedupe([
    ...ngrams(titleToks, 3),
    ...ngrams(titleToks, 2),
    "election commission",
    "supreme court",
    "lok sabha",
    "union budget",
    "defence minister",
  ]);

  return { tokens, phrases };
}

// -----------------------------------------------------------------------------
// SEARCH GOOGLE DRIVE
// -----------------------------------------------------------------------------
async function searchDriveCandidates(tokens = [], phrases = []) {
  if (!drive) return [];

  const qParts = [];

  for (const t of tokens) {
    if (t.length >= 3) qParts.push(`name contains '${t}'`);
  }

  for (const p of phrases) {
    const plain = p.replace(/\s+/g, "");
    const hyph = p.replace(/\s+/g, "-");
    qParts.push(`name contains '${plain}'`);
    qParts.push(`name contains '${hyph}'`);
  }

  const query = qParts.length
    ? `(${qParts.join(" or ")}) and '${DRIVE_FOLDER_ID}' in parents`
    : `'${DRIVE_FOLDER_ID}' in parents`;

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name, mimeType, modifiedTime)",
    pageSize: 100,
  });

  return res.data.files || [];
}

// -----------------------------------------------------------------------------
// SCORING ENGINE (IMPROVED)
// -----------------------------------------------------------------------------
function scoreFile(f, tokens, phrases, strongNames) {
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

  // Strong-name BOOST
  for (const s of strongNames) {
    if (name.includes(s)) score += 10;
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
    resource_type: "image",
  });

  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  } catch (err) {
    console.warn("[imagePicker] cleanup warning:", err);
  }

  return {
    publicId: uploaded.public_id,
    url: uploaded.secure_url,
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
        $or: [{ title: regex }, { summary: regex }],
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
      pickedIndex: index,
    },
  };
}

// -----------------------------------------------------------------------------
// MAIN EXPORT
// -----------------------------------------------------------------------------
exports.chooseHeroImage = async function (meta = {}) {
  try {
    if (!DRIVE_FOLDER_ID) {
      return {
        publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
        url: cloudinary.url(process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID),
        why: { mode: "no-drive-folder-id" },
      };
    }

    if (!drive) {
      return {
        publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
        url: cloudinary.url(process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID),
        why: { mode: "no-drive-client", credSource },
      };
    }

    const { tokens, phrases } = buildTokens(meta);
    const strongNames = strongNamesFrom(meta.title, meta.summary);

    let candidates = await searchDriveCandidates(tokens, phrases);

    // Fallback list-all
    if (!candidates.length) {
      const res = await drive.files.list({
        q: `'${DRIVE_FOLDER_ID}' in parents`,
        fields: "files(id, name, mimeType, modifiedTime)",
        pageSize: 50,
      });
      candidates = res.data.files || [];
    }

    if (!candidates.length) {
      return {
        publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
        url: cloudinary.url(process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID),
        why: { mode: "no-drive-files" },
      };
    }

    let best = null;
    let rotationMeta = null;

    // Person rotation
    const personKey = strongNames.length ? strongNames[0] : null;
    if (personKey) {
      const lower = personKey.toLowerCase();
      const personCandidates = candidates.filter((f) =>
        f.name.toLowerCase().includes(lower)
      );

      if (personCandidates.length > 0) {
        const rotated = await pickRotatedPersonFile(personKey, personCandidates);
        if (rotated && rotated.file) {
          best = { file: rotated.file, score: null, matchedTokens: [] };
          rotationMeta = rotated.meta;
        }
      }
    }

    // Standard scoring
    if (!best) {
      for (const f of candidates) {
        const pack = scoreFile(f, tokens, phrases, strongNames);
        const scored = { file: f, score: pack.score, matchedTokens: pack.matchedTokens };

        if (!best || scored.score > best.score) best = scored;
      }
    }

    // MINIMUM SCORE THRESHOLD
    if (best.score !== null && best.score < 8) {
      return {
        publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
        url: cloudinary.url(process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID),
        why: { mode: "weak-match-fallback", score: best.score },
      };
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
        credSource,
      },
    };
  } catch (err) {
    console.error("[imagePicker ERROR]", err);
    return {
      publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
      url: cloudinary.url(process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID),
      why: { mode: "error", error: String(err) },
    };
  }
};
