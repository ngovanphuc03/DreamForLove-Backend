const logger = require('../config/logger');

/// Global Express error-handling middleware
function errorHandler(err, req, res, next) {  // eslint-disable-line no-unused-vars
    // Normalize: some code uses err.status, some err.statusCode
    const code = err.statusCode || err.status || 500;
    err.statusCode = code;

    // Log stack trace for server errors only
    if (code >= 500) {
        logger.error({
            message: err.message,
            stack: err.stack,
            method: req.method,
            url: req.originalUrl,
            user: req.user?.uid ?? 'unauthenticated',
        });
    }

    // Validation errors from express-validator (thrown via validationResult)
    if (err.type === 'validation') {
        return res.status(422).json({
            error: 'Validation failed',
            detail: err.errors,
        });
    }

    // Postgres unique-violation (23505) — e.g. duplicate firebase_uid
    if (err.code === '23505') {
        return res.status(409).json({ error: 'Resource already exists' });
    }

    // Postgres FK-violation (23503)
    if (err.code === '23503') {
        return res.status(400).json({ error: 'Referenced resource does not exist' });
    }

    // Postgres string/value too long (22001)
    if (err.code === '22001') {
        return res.status(400).json({ error: 'Dữ liệu quá dài so với giới hạn cho phép' });
    }

    // Postgres invalid text representation / bad type cast (22P02)
    if (err.code === '22P02') {
        return res.status(400).json({ error: 'Dữ liệu đầu vào không đúng định dạng' });
    }

    // Postgres check constraint violation (23514)
    if (err.code === '23514') {
        return res.status(400).json({ error: 'Dữ liệu không thỏa điều kiện hợp lệ' });
    }

    // Known operational error with explicit statusCode
    if (err.statusCode && err.statusCode < 500) {
        return res.status(err.statusCode).json({ error: err.message });
    }

    // Fallback — don't leak internal details in production
    const statusCode = err.statusCode || 500;
    const message =
        process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;

    return res.status(statusCode).json({ error: message });
}

/// Helper: create an operational error with a status code
function createError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

module.exports = { errorHandler, createError };
