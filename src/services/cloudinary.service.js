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
  secure: true,
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

/**
 * Upload an image buffer to Cloudinary WITHOUT writing to disk.
 * Uses upload_stream under the hood.
 */
function uploadImageBuffer(
  buffer,
  { folder = `${CLOUDINARY_FOLDER}/library`, public_id, overwrite = false } = {}
) {
  return new Promise((resolve, reject) => {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      return reject(new Error("Missing image buffer"));
    }

    const options = {
      folder,
      resource_type: "image",
      overwrite,
    };

    if (public_id) options.public_id = public_id;

    const uploadStream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve({
        url: result.secure_url,
        public_id: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
      });
    });

    uploadStream.end(buffer);
  });
}

async function deleteCloudinaryAsset(publicId) {
  if (!publicId) return { result: "missing_publicId" };
  return cloudinary.uploader.destroy(publicId, { resource_type: "image" });
}

module.exports = { uploadRemoteImage, uploadImageBuffer, deleteCloudinaryAsset };
