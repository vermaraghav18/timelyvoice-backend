// backend/src/services/googleDrive.js
// Google Drive → download buffer + list files

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_DRIVE_KEY_FILE ||
  path.join(__dirname, "../../keys/google-drive-service-account.json");

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error(
    "❌ Google Drive service account JSON missing at:",
    SERVICE_ACCOUNT_PATH
  );
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
      fields: "files(id, name, mimeType, modifiedTime)",
      pageSize: 200,
    });

    const files = res.data.files || [];
    console.log(
      `[Drive] listFilesInFolder: folder=${folderId}, count=${files.length}`
    );
    return files;
  } catch (err) {
    console.error("[Drive] listFilesInFolder error:", err.message || err);
    return [];
  }
}

async function downloadFileBuffer(fileId) {
  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    console.log("[Drive] downloadFileBuffer ok:", fileId);
    return Buffer.from(res.data);
  } catch (err) {
    console.error("[Drive] downloadFileBuffer error:", fileId, err.message || err);
    throw err;
  }
}

module.exports = {
  listFilesInFolder,
  downloadFileBuffer,
};
