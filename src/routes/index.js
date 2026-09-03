const express = require('express');
const authRoutes = require('./auth.routes');
const coupleRoutes = require('./couple.routes');
const wishlistRoutes = require('./wishlist.routes');
const moodRoutes = require('./mood.routes');
const foodRoutes = require('./food.routes');
const tripRoutes = require('./trip.routes');
const periodRoutes = require('./period.routes');

const router = express.Router();

function resolveRouter(routeModule, moduleName) {
    // Accept common export shapes to prevent startup crashes on mixed CJS/ESM patterns.
    const resolved = routeModule?.default || routeModule?.router || routeModule;

    if (typeof resolved !== 'function') {
        const exportedKeys = routeModule && typeof routeModule === 'object'
            ? Object.keys(routeModule).join(', ')
            : String(routeModule);
        throw new TypeError(
            `[Routes] ${moduleName} must export an Express router function. Received: ${typeof routeModule}. Keys: ${exportedKeys}`
        );
    }

    return resolved;
}

router.use('/auth', resolveRouter(authRoutes, 'auth.routes'));
router.use('/couple', resolveRouter(coupleRoutes, 'couple.routes'));
router.use('/couple/period', resolveRouter(periodRoutes, 'period.routes'));
router.use('/period', resolveRouter(periodRoutes, 'period.routes'));
router.use('/wishlist', resolveRouter(wishlistRoutes, 'wishlist.routes'));
router.use('/mood', resolveRouter(moodRoutes, 'mood.routes'));
router.use('/food', resolveRouter(foodRoutes, 'food.routes'));
router.use('/trips', resolveRouter(tripRoutes, 'trip.routes'));

module.exports = router;
