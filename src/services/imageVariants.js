// backend/src/services/imageVariants.js
const cloudinary = require('cloudinary').v2;

const OG_W = parseInt(process.env.CLOUDINARY_OG_WIDTH  || '1200', 10);
const OG_H = parseInt(process.env.CLOUDINARY_OG_HEIGHT || '630', 10);

function buildImageVariants(publicId) {
  if (!publicId) return { originalUrl: undefined, ogUrl: undefined, thumbUrl: undefined };

  const originalUrl = cloudinary.url(publicId, { secure: true });
  const ogUrl = cloudinary.url(publicId, {
    width: OG_W, height: OG_H, crop: 'fill', gravity: 'auto', format: 'jpg', secure: true,
  });
  const thumbUrl = cloudinary.url(publicId, {
    width: 400, height: 300, crop: 'fill', gravity: 'auto', format: 'webp', secure: true,
  });

  return { originalUrl, ogUrl, thumbUrl };
}

module.exports = { buildImageVariants };
