const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

// Accept either ObjectId OR string (slug/name) for category until everything is unified
const categoryField = z.union([objectId, z.string().min(1)]).optional();

// Accept tags as array of ObjectIds OR array of strings
const tagsField = z.array(z.union([objectId, z.string().min(1)])).optional();

// Basic URL string (allow empty via optional/nullable elsewhere)
const urlField = z.string().url();

// "cover" schema kept for backward compatibility with older admin/frontends
const legacyCoverSchema = z
  .object({
    url: urlField,
    alt: z.string().max(120).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .optional();

exports.ArticleCreateSchema = z.object({
  // Core content
  title: z.string().min(3).max(160),
  summary: z.string().max(600).optional().or(z.literal('')), // ✅ your app uses summary
  excerpt: z.string().max(300).optional().or(z.literal('')),
  body: z.string().optional().or(z.literal('')),

  // Category/tags
  category: categoryField,
  categorySlug: z.string().optional(),
  tags: tagsField,

  // Status + placement
  status: z.enum(['draft', 'published']).optional(),
  homepagePlacement: z.enum(['none', 'top', 'latest', 'trending']).optional(),

  // SEO
  metaTitle: z.string().max(80).optional().or(z.literal('')),
  metaDesc: z.string().max(200).optional().or(z.literal('')),
  ogImage: z.string().url().optional().or(z.literal('')),

  // ✅ Current image fields used by your system
  imageUrl: z.string().optional().or(z.literal('')),
  imagePublicId: z.string().optional().or(z.literal('')),
  imageAlt: z.string().max(180).optional().or(z.literal('')),
  thumbImage: z.string().optional().or(z.literal('')),

  // ✅ NEW: persist auto picker debug reason
  autoImageDebug: z.any().nullable().optional(),

  // Legacy (keep, so older clients don’t break)
  cover: legacyCoverSchema,
});

exports.ArticleUpdateSchema = exports.ArticleCreateSchema.partial();
