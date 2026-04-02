const express = require('express');
const authRoutes = require('./auth.routes');
const coupleRoutes = require('./couple.routes');
const petRoutes = require('./pet.routes');
const wishlistRoutes = require('./wishlist.routes');
const moodRoutes = require('./mood.routes');
const foodRoutes = require('./food.routes');
const tripRoutes = require('./trip.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/couple', coupleRoutes);
router.use('/wishlist', wishlistRoutes);
router.use('/mood', moodRoutes);
router.use('/food', foodRoutes);
router.use('/trips', tripRoutes);

module.exports = router;
