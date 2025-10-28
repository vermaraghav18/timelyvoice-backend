const Ad = require("../models/Ad");

/**
 * GET /api/admin/ads
 * Optional filters: ?targetType=homepage|category|path & ?targetValue=
 */
exports.list = async (req, res) => {
  try {
    const { targetType, targetValue } = req.query || {};
    const q = {};
    if (targetType) q["target.type"] = targetType;
    if (typeof targetValue !== "undefined") q["target.value"] = targetValue;

    const items = await Ad.find(q)
      .sort({ placementIndex: 1, createdAt: 1 })
      .lean();

    res.json(items);
  } catch (e) {
    console.error("[ads.list]", e);
    res.status(500).json({ error: "Failed to load ads" });
  }
};

/**
 * GET /api/admin/ads/:id
 */
exports.read = async (req, res) => {
  try {
    const doc = await Ad.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    res.status(400).json({ error: "Bad id" });
  }
};

/**
 * POST /api/admin/ads
 * Body:
 * {
 *   imageUrl, linkUrl, placementIndex, enabled, target: {type, value}, notes,
 *   custom: { afterNth?: number, ... }
 * }
 */
exports.create = async (req, res) => {
  try {
    const payload = normalizePayload(req.body);

    const doc = await Ad.create(payload);
    res.status(201).json(doc);
  } catch (e) {
    console.error("[ads.create]", e);
    res.status(400).json({ error: e?.message || "Create failed" });
  }
};

/**
 * PATCH /api/admin/ads/:id
 * Accepts the same fields as create (partial allowed).
 * Merges custom fields; coerces custom.afterNth to number when present.
 */
exports.update = async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await Ad.findById(id);
    if (!existing) return res.status(404).json({ error: "Not found" });

    const update = normalizeUpdatePayload(req.body, existing);

    const doc = await Ad.findByIdAndUpdate(id, update, { new: true });
    res.json(doc);
  } catch (e) {
    console.error("[ads.update]", e);
    res.status(400).json({ error: e?.message || "Update failed" });
  }
};

/**
 * DELETE /api/admin/ads/:id
 */
exports.remove = async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await Ad.findById(id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    await Ad.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (e) {
    console.error("[ads.remove]", e);
    res.status(400).json({ error: "Delete failed" });
  }
};

/* --------------------- helpers --------------------- */

/**
 * Build a full create payload, coercing types and ensuring
 * custom.afterNth is numeric when provided.
 */
function normalizePayload(body = {}) {
  const enabled = body.enabled !== false; // default true
  const placementIndex = Number(body.placementIndex ?? 0);

  // target: expect { type, value }
  const target = body.target && typeof body.target === "object"
    ? { type: String(body.target.type || ""), value: String(body.target.value || "") }
    : { type: "homepage", value: "" };

  // Merge custom and coerce afterNth if present
  const customIn = body.custom && typeof body.custom === "object" ? body.custom : {};
  const custom = {
    ...customIn,
    ...(customIn.afterNth != null && customIn.afterNth !== ""
      ? { afterNth: Number(customIn.afterNth) }
      : {}),
  };

  return {
    imageUrl: String(body.imageUrl || ""),
    linkUrl: String(body.linkUrl || ""),
    placementIndex,
    enabled,
    target,
    notes: String(body.notes || ""),
    custom,
  };
}

/**
 * Build a partial update payload. Merge custom safely with existing.
 */
function normalizeUpdatePayload(body = {}, existing) {
  const update = {};

  if (body.imageUrl !== undefined) update.imageUrl = String(body.imageUrl || "");
  if (body.linkUrl !== undefined) update.linkUrl = String(body.linkUrl || "");

  if (body.placementIndex !== undefined) {
    update.placementIndex = Number(body.placementIndex ?? 0);
  }

  if (body.enabled !== undefined) {
    update.enabled = body.enabled !== false;
  }

  if (body.target !== undefined && typeof body.target === "object") {
    update.target = {
      type: String(body.target.type || existing?.target?.type || "homepage"),
      value: String(body.target.value || existing?.target?.value || ""),
    };
  }

  if (body.notes !== undefined) {
    update.notes = String(body.notes || "");
  }

  // Custom: merge with existing; coerce afterNth if present
  if (body.custom !== undefined) {
    const customIn = body.custom && typeof body.custom === "object" ? body.custom : {};
    const merged = { ...(existing.custom || {}), ...customIn };

    if (customIn.afterNth !== undefined) {
      if (customIn.afterNth === "" || customIn.afterNth == null) {
        // remove if blank
        delete merged.afterNth;
      } else {
        merged.afterNth = Number(customIn.afterNth);
      }
    }

    update.custom = merged;
  }

  return update;
}
