// backend/src/routes/sections.js
const router = require("express").Router();
const ctrl = require("../controllers/sections.controller");
const { withValidation } = require("../validators/withValidation");
const z = require("zod");
const Section = require("../models/Section");
const { DEFAULT_CAP, MAX_CAP } = require("../models/Section");

/* ================= Allowed templates ================= */
const ALLOWED_TEMPLATES = [
  // Head / blocks
  "head_v1",
  "head_v2",
  "top_v1",
  "top_v2",
  "grid_v1",
  "carousel_v1",
  "list_v1",
  "hero_v1",
  "feature_v1",
  "feature_v2",
  "mega_v1",
  "breaking_v1",
  "dark_v1",

  // Main layouts
  "main_v9",
  "main_v8",
  "main_v7",
  "main_v6",
  "main_v5",
  "main_v4",
  "main_v3",
  "main_v2",
  "main_v1",

  // Rails
  "rail_v3",
  "rail_v4",
  "rail_v5",
  "rail_v6",
  "rail_v7",
  "rail_v8",

  // ✅ New: FilmyBazaar rail template
  "rail_filmybazaar_v1",
  "rail_filmybazaar_v2",
  "rail_filmybazaar_v3",
  "rail_filmybazaar_v4",
  "rail_sports_v1", 
  "sports_v2",
  "sports_v3",
   "tech_main_v1",
];

/* ================= Helpers ================= */
function clampCapacity(template, capacity) {
  const def = DEFAULT_CAP[template] ?? 6;
  const max = MAX_CAP[template] ?? 24;
  let n = Number(capacity ?? def);
  if (!Number.isFinite(n) || n <= 0) n = def;
  return Math.max(1, Math.min(n, max));
}

/* ================= Validation ================= */

// Accept full http(s) OR site-relative path starting with "/"
const ImageUrlSchema = z
  .string()
  .trim()
  .refine((v) => /^(https?:\/\/|\/)/i.test(v), {
    message: "imageUrl must be http(s) URL or site-relative path (starts with /)",
  });

// rail_v7 custom payload (promo image)
const CustomV7Schema = z.object({
  imageUrl: ImageUrlSchema,
  alt: z.string().optional(),
  linkUrl: z.string().url().optional(),
  aspect: z.string().optional(),
});

// rail_v8 custom payload (news promo card)
const CustomV8Schema = z.object({
  imageUrl: ImageUrlSchema,
  title: z.string().min(1, "title is required"),
  summary: z.string().min(1, "summary is required"),
  linkUrl: z.string().url().optional(),
});

/* ====== top_v2 composite schemas ====== */
const ZoneSchema = z.object({
  enable: z.boolean().optional(),
  limit: z.number().int().min(0).optional(),
  query: z
    .object({
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      includeIds: z.array(z.string()).optional(),
      sinceDays: z.number().int().min(0).optional(),
    })
    .optional(),
});

const TopV2CustomSchema = z.object({
  dedupeAcrossZones: z.boolean().optional(),
  hero: ZoneSchema.optional(),
  sideStack: ZoneSchema.optional(),
  belowGrid: ZoneSchema.optional(),
  trending: ZoneSchema.optional(),
});
/* ====== /top_v2 ====== */

const BaseSectionSchema = z
  .object({
    title: z.string().min(1),
    slug: z.string().min(1),

    template: z
      .string()
      .default("head_v1")
      .refine((v) => ALLOWED_TEMPLATES.includes(v), {
        message: `Invalid template. Expected one of: ${ALLOWED_TEMPLATES.join(", ")}`,
      }),

    capacity: z.coerce.number().int().positive().max(100).optional(),

    // side (used for rails)
    side: z.enum(["left", "right", ""]).optional(),

    target: z.object({
      type: z.enum(["homepage", "path", "category"]),
      value: z.string(),
    }),

    feed: z
      .object({
        mode: z.enum(["auto", "manual", "mixed"]).default("auto"),
        categories: z.array(z.string()).default([]),
        tags: z.array(z.string()).default([]),
        sortBy: z.enum(["publishedAt", "priority"]).default("publishedAt"),
        timeWindowHours: z.coerce.number().int().min(0).default(0),
        sliceFrom: z.coerce.number().int().min(1).optional(),
        sliceTo: z.coerce.number().int().min(1).optional(),
      })
      .optional(),

    pins: z
      .array(
        z.object({
          articleId: z.string(),
          startAt: z.coerce.date().optional(),
          endAt: z.coerce.date().optional(),
        })
      )
      .optional(),

    moreLink: z.string().optional(),
    placementIndex: z.coerce.number().int().default(0).optional(),
    enabled: z.boolean().default(true).optional(),

    // template-specific payload; validated in superRefine
    custom: z.unknown().optional(),
  })
  .passthrough(); // keep unknown keys if present

const SectionCreateSchema = BaseSectionSchema.superRefine((val, ctx) => {
  if (val.template === "rail_v7") {
    const parsed = CustomV7Schema.safeParse(val.custom);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom is required for rail_v7 and must include a valid imageUrl",
        path: ["custom"],
      });
    }
  }
  if (val.template === "rail_v8") {
    const parsed = CustomV8Schema.safeParse(val.custom);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom is required for rail_v8 and must include imageUrl, title, summary",
        path: ["custom"],
      });
    }
  }
  if (val.template === "top_v2") {
    const parsed = TopV2CustomSchema.safeParse(val.custom ?? {});
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "custom for top_v2 must match { dedupeAcrossZones?, hero?, sideStack?, belowGrid?, trending? }",
        path: ["custom"],
      });
    }
  }
});

// PATCH allows partial updates but keeps template-specific checks
const SectionUpdateSchema = BaseSectionSchema.partial().superRefine((val, ctx) => {
  const tpl = val.template;
  if (tpl === "rail_v7" && val.custom !== undefined) {
    const parsed = CustomV7Schema.safeParse(val.custom);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom for rail_v7 must include a valid imageUrl",
        path: ["custom"],
      });
    }
  }
  if (tpl === "rail_v8" && val.custom !== undefined) {
    const parsed = CustomV8Schema.safeParse(val.custom);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom for rail_v8 must include imageUrl, title, summary",
        path: ["custom"],
      });
    }
  }
  if (tpl === "top_v2" && val.custom !== undefined) {
    const parsed = TopV2CustomSchema.safeParse(val.custom);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "custom for top_v2 must match { dedupeAcrossZones?, hero?, sideStack?, belowGrid?, trending? }",
        path: ["custom"],
      });
    }
  }
});

/* ============== Normalize body (capacity per template + target cleanup) ============== */
async function normalizeSectionBody(req, _res, next) {
  // Ensure target exists
  if (!req.body.target) req.body.target = {};
  const t = req.body.target?.type;
  let v = req.body.target?.value;

  if (typeof v === "string") v = v.trim();

  if (t === "category") {
    // categories are plain slugs: no leading slash, lowercase
    v = (v || "").replace(/^\/+/, "").toLowerCase();
  } else if (t === "path") {
    // paths must start with a single slash
    v = "/" + String(v || "/").replace(/^\/+/, "");
  } else if (t === "homepage") {
    v = "/";
  }

  req.body.target = { type: t, value: v };

  // capacity clamp (needs template, falls back to existing if patching)
  let tpl = req.body?.template;
  if (!tpl && req.params?.id) {
    const existing = await Section.findById(req.params.id).select("template").lean();
    tpl = existing?.template || "head_v1";
  }
  req.body.capacity = clampCapacity(tpl, req.body.capacity);

  next();
}

/* =============================== Routes ============================== */

/**
 * Plan — normalize query so both styles work and fix category slashes:
 * - ?targetType=homepage&targetValue=/
 * - ?target=homepage&value=/
 * - category values like "/General" → "general"
 */
router.get("/plan", async (req, res, next) => {
  try {
    const t = req.query.targetType || req.query.target || "homepage";
    let v = req.query.targetValue || req.query.value || "/";

    if (t === "category" && typeof v === "string") {
      v = v.replace(/^\/+/, "").toLowerCase();
    }

    req.query.targetType = t;
    req.query.targetValue = v;
    return ctrl.plan(req, res);
  } catch (err) {
    next(err);
  }
});

router.get("/", ctrl.list);
router.get("/:id", ctrl.read);

// Single POST and PATCH definitions (no duplicates)
router.post(
  "/",
  (req, _res, next) => {
    next();
  },
  withValidation(SectionCreateSchema),
  normalizeSectionBody,
  ctrl.create
);

router.patch(
  "/:id",
  (req, _res, next) => {

    next();
  },
  withValidation(SectionUpdateSchema),
  normalizeSectionBody,
  ctrl.update
);

router.delete("/:id", ctrl.remove);

module.exports = router;
