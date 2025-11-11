// Simple JWT auth & role-based permit middleware
// Usage in routes:
//   router.post('/...', auth, permit(['editor','admin']), handler)

const jwt = require('jsonwebtoken');

function parseBearer(header = '') {
  // Accept: "Bearer <token>"
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

module.exports.auth = function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = parseBearer(header);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: missing bearer token' });
    }

    const secret = process.env.JWT_SECRET || process.env.AUTH_SECRET;
    if (!secret) {
      // Fails fast with clear message if secret is not configured
      return res.status(500).json({ error: 'Server auth misconfig: JWT_SECRET not set' });
    }

    const payload = jwt.verify(token, secret);

    // Expecting a payload that includes at least an id and a role
    // e.g. { id: '...', email: '...', role: 'admin', iat: ..., exp: ... }
    req.user = {
      id: payload.id || payload._id || payload.sub,
      email: payload.email,
      role: payload.role || 'user',
      ...payload, // keep any extra claims available
    };

    return next();
  } catch (err) {
    // Token invalid / expired
    return res.status(401).json({ error: 'Unauthorized: invalid or expired token' });
  }
};

module.exports.permit = function permit(roles = []) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    return next();
  };
};
