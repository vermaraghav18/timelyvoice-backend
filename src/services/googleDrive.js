// backend/src/services/googleDrive.js
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_DRIVE_KEY_FILE ||
  path.join(__dirname, "../../keys/google-drive-service-account.json");

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error("❌ Google Drive service account JSON missing at:", SERVICE_ACCOUNT_PATH);
} else {
  console.log("✅ Using Google Drive service account:", SERVICE_ACCOUNT_PATH);
}

const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_PATH,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({ version: "v3", auth });

async function listFilesInFolder(folderId) {
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: "files(id, name, mimeType, modifiedTime, thumbnailLink, webViewLink, size)",
      pageSize: 200,
      orderBy: "modifiedTime desc",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const files = res?.data?.files || [];
    console.log(`[Drive] list ok folder=${folderId} count=${files.length}`);
    return files;
  } catch (err) {
    console.error("[Drive] list error:", err?.response?.data || err?.message || err);
    throw err;
  }
}

async function downloadFileBuffer(fileId) {
  try {
    // 1) Fetch metadata first (helps debugging + ensures it’s an image)
    const meta = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,size",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const mimeType = meta?.data?.mimeType || "";
    const name = meta?.data?.name || "";
    const size = meta?.data?.size || "";

    if (!mimeType.startsWith("image/")) {
      throw new Error(`Drive file is not an image. name=${name} mimeType=${mimeType}`);
    }

    // 2) Download media
    const res = await drive.files.get(
      {
        fileId,
        alt: "media",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,

        // ✅ CRITICAL for many files blocked behind "virus scan" / "abusive" download warning
        acknowledgeAbuse: true,
      },
      { responseType: "arraybuffer" }
    );

    // googleapis can return ArrayBuffer/Uint8Array/Buffer
    let buf;
    if (Buffer.isBuffer(res.data)) {
      buf = res.data;
    } else {
      buf = Buffer.from(res.data);
    }

    if (!buf || buf.length === 0) {
      throw new Error(`Empty buffer from Drive download. name=${name} size=${size}`);
    }

    console.log("[Drive] download ok:", fileId, "name=", name, "bytes=", buf.length);
    return buf;
  } catch (err) {
    const status = err?.response?.status;
    const apiMsg =
      err?.response?.data?.error?.message ||
      err?.response?.data?.error ||
      err?.message ||
      String(err);

    // ✅ Make Drive errors very explicit
    const hint =
      status === 403
        ? " (403: Permission/blocked download. Ensure the file/folder is shared with the service account email.)"
        : status === 404
        ? " (404: File not found. Wrong fileId or service account has no access.)"
        : "";

    console.error("[Drive] download error:", fileId, apiMsg + hint);
    throw err;
  }
}



module.exports = { listFilesInFolder, downloadFileBuffer };
