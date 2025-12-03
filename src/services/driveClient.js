// src/services/driveClient.js
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

function getDriveClient() {
  let authOptions;
  let credSource;

  // Option 1: full JSON in env (Render)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credSource = "env-json";
    authOptions = {
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    };
  } else {
    // Option 2: local/server key file
    const keyFile =
      process.env.GOOGLE_DRIVE_KEY_FILE ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.join(__dirname, "../../keys/google-drive-service-account.json");

    credSource = keyFile;

    if (!fs.existsSync(keyFile)) {
      console.error(
        "[DriveAuth] ❌ service account JSON file not found at",
        keyFile
      );
    }

    authOptions = {
      keyFile,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    };
  }

  const auth = new google.auth.GoogleAuth(authOptions);
  const drive = google.drive({ version: "v3", auth });

  console.log(
    "[DriveAuth] ✅ Google Drive client initialised using",
    credSource
  );

  return { drive, credSource };
}

module.exports = { getDriveClient };
