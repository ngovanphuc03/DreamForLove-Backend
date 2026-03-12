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

module.exports = { apiLimiter, authLimiter, codeLimiter };
