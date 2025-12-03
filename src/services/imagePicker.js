// -----------------------------------------------------------------------------
// imagePicker.js  (Google Drive → Cloudinary Hybrid Auto-Image System)
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { v2: cloudinary } = require("cloudinary");
const Article = require("../models/Article");

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
const DRIVE_FOLDER_ID =
  process.env.GOOGLE_DRIVE_NEWS_FOLDER_ID ||
  process.env.GOOGLE_DRIVE_FOLDER_ID; // try NEWS first, fallback to old name

const TEMP_DIR = path.join(__dirname, "../../tmp-drive-images");

// Ensure tmp directory exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Cloudinary config (safe)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// -----------------------------------------------------------------------------
// GOOGLE DRIVE AUTH (env JSON first, then local file) — RENDER SAFE
// -----------------------------------------------------------------------------
let credentials = undefined;
let credSource = "none";

if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    credSource = "env-json";
  } catch (err) {
    console.error("[Drive] Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", err);
  }
}

if (!credentials) {
  try {
    const keyFile = path.join(
      __dirname,
      "../../keys/google-drive-service-account.json"
    );
    if (fs.existsSync(keyFile)) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      credentials = require(keyFile);
      credSource = "local-file";
    }
  } catch (err) {
    console.error("[Drive] Failed to load local key file:", err);
  }
}

console.log("[Drive] credential source:", credSource);

let drive = null;
try {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  drive = google.drive({ version: "v3", auth });
} catch (err) {
  console.error("[Drive] Failed to init Google Drive client:", err);
}

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
  "india",
  "indian",
  "country",
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

function strongNamesFrom(title, summary) {
  const toks = tokenize(`${title} ${summary}`);
  return dedupe(
    toks.filter((t) =>
      /^(modi|rahul|rajnath|gandhi|singh|ambani|adani|shah|yogi|kejriwal|trump|biden|musk)$/.test(
        t
      )
    )
  );
}

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
// Build tokens + phrases
// -----------------------------------------------------------------------------
function buildTokens(meta) {
  const raw = dedupe(tokenize(`${meta.title} ${meta.summary} ${meta.slug}`))
    .map(stem)
    .filter((t) => !STOPWORDS.has(t) && t.length >= 3);

  if (meta.category)
    raw.push(...tokenize(meta.category).map((t) => stem(t)));
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
// 1) SEARCH GOOGLE DRIVE
// -----------------------------------------------------------------------------
async function searchDriveCandidates(tokens = [], phrases = []) {
  if (!drive) {
    return [];
  }

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
// 2) SCORE CANDIDATES
// -----------------------------------------------------------------------------
function scoreFile(f, tokens, phrases, strongNames) {
  const name = f.name.toLowerCase();
  let score = 0;

  // phrase boost
  for (const p of phrases) {
    const plain = p.replace(/\s+/g, "");
    const hyph = p.replace(/\s+/g, "-");
    if (name.includes(plain) || name.includes(hyph) || name.includes(p))
      score += 7;
  }

  // token boost
  for (const t of tokens) {
    if (name.includes(t)) score += 2;
  }

  // multi-match bonus
  const matchedTokens = tokens.filter((t) => name.includes(t));
  if (matchedTokens.length >= 2) score += 2;

  // famous-name penalty
  score += negativePenalty(name, strongNames);

  return { score, matchedTokens };
}

// -----------------------------------------------------------------------------
// 3) DOWNLOAD FROM DRIVE → TEMP → UPLOAD TO CLOUDINARY
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

  // Upload to Cloudinary folder: news-images/google/
  const uploaded = await cloudinary.uploader.upload(destPath, {
    folder: process.env.CLOUDINARY_FOLDER
      ? `${process.env.CLOUDINARY_FOLDER}/google`
      : "news-images/google",
    resource_type: "image",
  });

  // Safe cleanup: don't let unlink errors break the flow
  try {
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
  } catch (cleanupErr) {
    console.warn("[imagePicker Drive] cleanup warning:", cleanupErr);
  }

  return {
    publicId: uploaded.public_id,
    url: uploaded.secure_url,
  };
}

// -----------------------------------------------------------------------------
// 4) PERSON-SPECIFIC ROTATION HELPER (modi-01, modi-02, ...)
// -----------------------------------------------------------------------------
async function pickRotatedPersonFile(personKey, candidates) {
  if (!personKey || !Array.isArray(candidates) || !candidates.length) {
    return null;
  }

  // Count how many articles already mention this person (title or summary)
  const regex = new RegExp(personKey, "i");
  const usedCount = await Article.countDocuments({
    $or: [{ title: regex }, { summary: regex }],
  });

  // Stable order by file name, so rotation is predictable: modi-01, modi-02, ...
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
// MAIN PUBLIC FUNCTION
// -----------------------------------------------------------------------------
exports.chooseHeroImage = async function (meta = {}) {
  try {
    // Basic safety checks for prod
    if (!DRIVE_FOLDER_ID) {
      const why = { mode: "no-drive-folder-id" };
      console.error(
        "[imagePicker Drive] ERROR: DRIVE_FOLDER_ID is not configured (.env GOOGLE_DRIVE_NEWS_FOLDER_ID / GOOGLE_DRIVE_FOLDER_ID)"
      );
      console.warn("[imagePicker Drive] DEBUG:", { metaTitle: meta.title, why });
      return {
        publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
        url: cloudinary.url(
          process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID
        ),
        why,
      };
    }

    if (!drive) {
      const why = { mode: "no-drive-client", credSource };
      console.error("[imagePicker Drive] ERROR: Drive client not initialized");
      console.warn("[imagePicker Drive] DEBUG:", { metaTitle: meta.title, why });
      return {
        publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
        url: cloudinary.url(
          process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID
        ),
        why,
      };
    }

    const { tokens, phrases } = buildTokens(meta);
    const strongNames = strongNamesFrom(meta.title, meta.summary);

    let candidates = await searchDriveCandidates(tokens, phrases);

    // Fallback: list everything in folder
    if (!candidates.length) {
      const all = await drive.files.list({
        q: `'${DRIVE_FOLDER_ID}' in parents`,
        fields: "files(id, name, mimeType, modifiedTime)",
        pageSize: 50,
      });
      candidates = all.data.files || [];
    }

    if (!candidates.length) {
      const why = { mode: "no-drive-files" };
      console.warn("[imagePicker Drive] DEBUG:", {
        metaTitle: meta.title,
        why,
      });
      return {
        publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
        url: cloudinary.url(
          process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID
        ),
        why,
      };
    }

    // 4A) Try PERSON-BASED ROTATION first (e.g. modi-01, modi-02, ...)
    let best = null;
    let rotationMeta = null;

    const personKey = strongNames.length ? strongNames[0] : null;
    if (personKey) {
      const lowerKey = personKey.toLowerCase();
      const personCandidates = candidates.filter((f) =>
        f.name.toLowerCase().includes(lowerKey)
      );

      if (personCandidates.length > 0) {
        const rotated = await pickRotatedPersonFile(personKey, personCandidates);
        if (rotated && rotated.file) {
          best = {
            file: rotated.file,
            score: null,
            matchedTokens: [],
          };
          rotationMeta = rotated.meta;
        }
      }
    }

    // 4B) Fallback to scoring logic if no rotation
    if (!best) {
      for (const f of candidates) {
        const { score, matchedTokens } = scoreFile(
          f,
          tokens,
          phrases,
          strongNames
        );
        const pack = { file: f, score, matchedTokens };

        if (!best || score > best.score) best = pack;
      }
    }

    // Download + Upload to Cloudinary
    const uploaded = await downloadAndUploadToCloudinary(best.file);

    const baseWhy = {
      mode: rotationMeta ? rotationMeta.mode : "drive-picked",
      file: best.file.name,
      score: best.score,
      matchedTokens: best.matchedTokens,
    };

    const why = rotationMeta ? { ...baseWhy, rotation: rotationMeta } : baseWhy;

    console.log("[imagePicker Drive] DEBUG:", {
      metaTitle: meta.title,
      why,
    });

    return {
      publicId: uploaded.publicId,
      url: uploaded.url,
      why,
    };
  } catch (err) {
    const why = { mode: "error", error: String(err) };
    console.error("[imagePicker Drive] ERROR:", err);
    console.error("[imagePicker Drive] DEBUG:", {
      metaTitle: meta.title,
      why,
    });
    return {
      publicId: process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID,
      url: cloudinary.url(
        process.env.CLOUDINARY_DEFAULT_IMAGE_PUBLIC_ID
      ),
      why,
    };
  }
};
