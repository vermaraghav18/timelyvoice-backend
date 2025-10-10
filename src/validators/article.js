const { z } = require('zod');

const id = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

exports.ArticleCreateSchema = z.object({
  title: z.string().min(3).max(160),
  excerpt: z.string().max(300).optional().or(z.literal('')),
  body: z.string().optional().or(z.literal('')),
  category: id.optional(),
  tags: z.array(id).optional(),
  metaTitle: z.string().max(70).optional(),
  metaDesc: z.string().max(160).optional(),
  ogImage: z.string().url().optional(),
  cover: z.object({
    url: z.string().url(),
    alt: z.string().max(120).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional()
  }).optional()
});

exports.ArticleUpdateSchema = exports.ArticleCreateSchema.partial();
