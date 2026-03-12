const { validationResult } = require('express-validator');

/**
 * Middleware: kiểm tra kết quả validation từ express-validator.
 * Đặt SAU các mảng validation rules trong route.
 */
function validateRequest(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({
            error: 'Dữ liệu không hợp lệ',
            detail: errors.array(),
        });
    }
    next();
}

module.exports = { validateRequest };
