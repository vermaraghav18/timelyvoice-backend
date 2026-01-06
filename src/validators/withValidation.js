exports.withValidation = (schema, pick = 'body') => (req, res, next) => {
  console.log("🔥 withValidation HIT:", pick, req.originalUrl);

  const data =
    pick === 'query'
      ? req.query
      : pick === 'params'
      ? req.params
      : req.body;

  const parsed = schema.safeParse(data);

  if (!parsed.success) {
    console.log("❌ VALIDATION FAILED", parsed.error.flatten());
    return res.status(400).json({
      error: 'invalid_request',
      details: parsed.error.flatten(),
    });
  }

  if (pick === 'body') req.body = parsed.data;
  if (pick === 'query') req.query = parsed.data;
  if (pick === 'params') req.params = parsed.data;

  next();
};
