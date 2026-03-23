const rateLimit = require('express-rate-limit');

/// General API rate limiter: 200 req / 15 min per IP
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
});

/// Strict limiter for auth endpoints: 20 req / 15 min per IP
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts, please try again later.' },
});

/// Strict limiter for code-join endpoint: 10 attempts / 15 min per IP
const codeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many pairing attempts, please try again later.' },
});

/// Per-user limiter for code generation: 5 codes / 10 min.
const generateCodeLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.dbUser?.id ?? req.ip,
    message: { error: 'Bạn tạo mã quá nhanh, vui lòng thử lại sau vài phút.' },
    skip: (req) => !req.dbUser,
});

/**
 * Per-USER heartbeat limiter: max 10 pings / 1 min per authenticated user.
 * Uses req.dbUser.id as key (set by verifyAuth + requireCouple) so that
 * users behind the same NAT cannot be blocked by each other.
 */
const heartbeatLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.dbUser?.id ?? req.ip,
    message: { error: 'Gửi quá nhiều rung tim, hãy thử lại sau 1 phút nhé 💕' },
    skip: (req) => !req.dbUser,  // Skip if not yet authenticated (will 401 anyway)
});

module.exports = {
    apiLimiter,
    authLimiter,
    codeLimiter,
    generateCodeLimiter,
    heartbeatLimiter,
};
