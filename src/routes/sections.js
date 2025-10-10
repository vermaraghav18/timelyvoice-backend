// backend/src/routes/sections.js
const router = require("express").Router();
const ctrl = require("../controllers/sections.controller");
const { withValidation } = require("../validators/withValidation");
const z = require("zod");
const Section = require("../models/Section");
const { DEFAULT_CAP, MAX_CAP } = require("../models/Section");

/* ================= Allowed templates ================= */
const ALLOWED_TEMPLATES = [
  "head_v1",
  "head_v2",
  "top_v1",
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

// rail_v7 custom payload
const CustomV7Schema = z.object({
  imageUrl: ImageUrlSchema,
  alt: z.string().optional(),
  linkUrl: z.string().url().optional(),
  aspect: z.string().optional(),
});

// rail_v8 custom payload (news card)
const CustomV8Schema = z.object({
  imageUrl: ImageUrlSchema,
  title: z.string().min(1, "title is required"),
  summary: z.string().min(1, "summary is required"),
  linkUrl: z.string().url().optional(),
});

const BaseSectionSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),

  template: z
    .string()
    .default("head_v1")
    .refine((v) => ALLOWED_TEMPLATES.includes(v), {
      message: `Invalid template. Expected one of: ${ALLOWED_TEMPLATES.join(", ")}`,
    }),

  capacity: z.coerce.number().int().positive().max(100).optional(),

  // keep side (used for rails)
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

  // we'll validate the shape based on template in superRefine
  custom: z.unknown().optional(),
}).passthrough(); // don’t drop unlisted keys accidentally

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
});

// PATCH allows partial updates but keeps the same template-specific checks
const SectionUpdateSchema = BaseSectionSchema.partial().superRefine((val, ctx) => {
  // We need the effective template to know what to validate.
  // If template not supplied in PATCH body, look up existing template.
  // (Handled in normalizeSectionBody for capacity; here, only validate if we have enough info.)
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
});

/* ============== Normalize body (capacity per template) ============== */
async function normalizeSectionBody(req, _res, next) {
  let t = req.body?.template;
  if (!t && req.params?.id) {
    const existing = await Section.findById(req.params.id).select("template").lean();
    t = existing?.template || "head_v1";
  }
  req.body.capacity = clampCapacity(t, req.body.capacity);
  next();
}

/* =============================== Routes ============================== */

/**
 * Plan — normalize query so both styles work:
 * - ?targetType=homepage&targetValue=/
 * - ?target=homepage&value=/
 * Then delegate to controller (which merges fields for rails like rail_v7/v8).
 */
router.get("/plan", async (req, res, next) => {
  try {
    req.query.targetType = req.query.targetType || req.query.target || "homepage";
    req.query.targetValue = req.query.targetValue || req.query.value || "/";
    return ctrl.plan(req, res);
  } catch (err) {
    next(err);
  }
});

router.get("/", ctrl.list);
router.get("/:id", ctrl.read);

router.post("/", withValidation(SectionCreateSchema), normalizeSectionBody, ctrl.create);
router.patch("/:id", withValidation(SectionUpdateSchema), normalizeSectionBody, ctrl.update);
router.post(
  "/",
  (req, _res, next) => { console.log("DEBUG CREATE /api/sections body:", req.body); next(); },
  withValidation(SectionCreateSchema),
  normalizeSectionBody,
  ctrl.create
);

router.patch(
  "/:id",
  (req, _res, next) => { console.log("DEBUG UPDATE /api/sections body:", req.body); next(); },
  withValidation(SectionUpdateSchema),   // or your current schema
  normalizeSectionBody,
  ctrl.update
);

router.delete("/:id", ctrl.remove);

module.exports = router;
