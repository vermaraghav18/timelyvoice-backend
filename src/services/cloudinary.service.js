"use strict";

const cloudinary = require("cloudinary").v2;

const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  CLOUDINARY_FOLDER = "news-images",
} = process.env;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.warn("[cloudinary] Missing env vars; uploads will fail.");
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

async function uploadRemoteImage(remoteUrl, { folder = CLOUDINARY_FOLDER } = {}) {
  if (!remoteUrl) return { url: "", public_id: "" };
  const up = await cloudinary.uploader.upload(remoteUrl, {
    folder,
    overwrite: false,
    resource_type: "image",
  });
  return { url: up.secure_url, public_id: up.public_id };
}

module.exports = { uploadRemoteImage };
