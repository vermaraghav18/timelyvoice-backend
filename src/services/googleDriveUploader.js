// backend/src/services/googleDriveUploader.js
// Google Drive → Cloudinary uploader (hybrid system)

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const cloudinary = require("cloudinary").v2;

// 1) Load service account credentials from backend/keys/google-drive-service-account.json
const SERVICE_ACCOUNT_PATH = path.join(
  __dirname,
  "../../keys/google-drive-service-account.json"
);

let credentials;
try {
  const raw = fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8");
  credentials = JSON.parse(raw);
} catch (err) {
  console.error(
    "[googleDriveUploader] Could not read service account file at",
    SERVICE_ACCOUNT_PATH,
    err.message
  );
  credentials = null;
}

// 2) Configure Google Drive client
let drive = null;
if (credentials) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  drive = google.drive({
    version: "v3",
    auth,
  });
} else {
  console.error(
    "[googleDriveUploader] WARNING: No Drive credentials loaded. Drive uploads will fail."
  );
}

// 3) Helper: extract fileId from a Drive URL or accept a raw ID
function extractDriveFileId(input = "") {
  if (!input) return null;
  const s = String(input).trim();

  // If they passed a plain ID, just use it
  if (!s.includes("drive.google.com")) {
    return s;
  }

  // Pattern: /file/d/FILE_ID/...
  const byPath = s.match(/\/file\/d\/([^/]+)/);
  if (byPath && byPath[1]) {
    return byPath[1];
  }

  // Pattern: ?id=FILE_ID
  const byParam = s.match(/[?&]id=([^&]+)/);
  if (byParam && byParam[1]) {
    return byParam[1];
  }

  return null;
}

// 4) Core function: download a Drive file and stream it into Cloudinary
async function uploadDriveImageToCloudinary(fileIdOrUrl, options = {}) {
  if (!drive) {
    throw new Error("Google Drive not initialized (missing credentials)");
  }

  const fileId = extractDriveFileId(fileIdOrUrl);
  if (!fileId) {
    throw new Error("Could not extract Google Drive file id from input");
  }

  const folder = options.folder || process.env.CLOUDINARY_FOLDER || "news-images";

  // Get the file contents as a stream from Drive
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
      },
      (err, result) => {
        if (err) {
          console.error("[googleDriveUploader] Cloudinary upload error:", err);
          return reject(err);
        }
        resolve(result);
      }
    );

    res.data.on("error", (err) => {
      console.error("[googleDriveUploader] Drive stream error:", err);
      uploadStream.destroy(err);
      reject(err);
    });

    // Pipe Drive image → Cloudinary upload_stream
    res.data.pipe(uploadStream);
  });
}


async function uploadDriveVideoToCloudinary(fileIdOrUrl, options = {}) {
  if (!drive) {
    throw new Error("Google Drive not initialized (missing credentials)");
  }

  const fileId = extractDriveFileId(fileIdOrUrl);
  if (!fileId) {
    throw new Error("Could not extract Google Drive file id from input");
  }

  const folder = options.folder || process.env.CLOUDINARY_VIDEO_FOLDER || "news-videos";

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "video",
      },
      (err, result) => {
        if (err) {
          console.error("[googleDriveUploader] Cloudinary video upload error:", err);
          return reject(err);
        }
        resolve(result);
      }
    );

    res.data.on("error", (err) => {
      console.error("[googleDriveUploader] Drive video stream error:", err);
      uploadStream.destroy(err);
      reject(err);
    });

    res.data.pipe(uploadStream);
  });
}


module.exports = {
  uploadDriveImageToCloudinary,
  uploadDriveVideoToCloudinary,
  extractDriveFileId,
};
