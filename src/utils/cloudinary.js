// src/utils/cloudinary.js
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function uploadImageToCloudinary(imageUrl) {
  try {
    const res = await cloudinary.uploader.upload(imageUrl, {
      folder: process.env.CLOUDINARY_FOLDER || "news-images",
      overwrite: false,
    });
    return res.secure_url;
  } catch (err) {
    console.error("[Cloudinary] Upload failed:", err.message);
    return process.env.AUTOMATION_DEFAULT_IMAGE_ID; // fallback
  }
}
