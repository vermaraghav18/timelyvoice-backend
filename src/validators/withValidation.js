exports.withValidation = (schema, pick = 'body') => (req, res, next) => {
  const data = pick === 'query' ? req.query : pick === 'params' ? req.params : req.body;
  const parsed = schema.safeParse(data);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten() });
  if (pick === 'body') req.body = parsed.data;
  if (pick === 'query') req.query = parsed.data;
  if (pick === 'params') req.params = parsed.data;
  next();
};
