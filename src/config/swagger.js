const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.3',
        info: {
            title: 'DreamForLove API',
            version: '1.0.2',
            description: 'Backend API for DreamForLove – Couple App',
            contact: { name: 'DreamForLove Team' },
        },
        servers: [
            { url: '/api/v1', description: 'API v1' },
            { url: '/api', description: 'API (default)' },
        ],
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'Firebase ID Token',
                    description: 'Firebase ID Token from client SDK',
                },
            },
            schemas: {
                Error: {
                    type: 'object',
                    properties: {
                        error: { type: 'string' },
                        request_id: { type: 'string', nullable: true },
                    },
                },
                User: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        firebase_uid: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        display_name: { type: 'string' },
                        photo_url: { type: 'string', nullable: true },
                        provider: { type: 'string' },
                        is_premium: { type: 'boolean' },
                        created_at: { type: 'string', format: 'date-time' },
                    },
                },
                CoupleRoom: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        user_display_name: { type: 'string' },
                        user_avatar: { type: 'string', nullable: true },
                        start_date: { type: 'string', format: 'date' },
                        days_together: { type: 'integer' },
                        partner_name: { type: 'string' },
                        partner_avatar: { type: 'string', nullable: true },
                        memory_photo_url: { type: 'string', nullable: true },
                        is_active: { type: 'boolean' },
                        is_premium: { type: 'boolean' },
                    },
                },
                Milestone: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        couple_room_id: { type: 'string', format: 'uuid' },
                        label: { type: 'string' },
                        target_days: { type: 'integer' },
                        emoji: { type: 'string' },
                        is_custom: { type: 'boolean' },
                        is_celebrated: { type: 'boolean' },
                    },
                },
                WishItem: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        category: { type: 'string' },
                        price: { type: 'number' },
                        priority: { type: 'string', enum: ['low', 'mid', 'high'] },
                        image_url: { type: 'string', nullable: true },
                        product_url: { type: 'string', nullable: true },
                        is_bought: { type: 'boolean' },
                        added_by_name: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                    },
                },
                FoodItem: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        emoji: { type: 'string' },
                        location: { type: 'string', nullable: true },
                        is_eaten: { type: 'boolean' },
                        added_by_name: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                    },
                },
                MoodLog: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        type: { type: 'string', enum: ['happy', 'sad', 'miss', 'angry', 'love'] },
                        note: { type: 'string', nullable: true },
                        user_id: { type: 'string', format: 'uuid' },
                        created_at: { type: 'string', format: 'date-time' },
                    },
                },
                TripPlan: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        title: { type: 'string' },
                        location: { type: 'string' },
                        note: { type: 'string', nullable: true },
                        planned_date: { type: 'string', format: 'date', nullable: true },
                        is_done: { type: 'boolean' },
                        added_by_name: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                    },
                },
                PaginatedList: {
                    type: 'object',
                    properties: {
                        count: { type: 'integer' },
                        total: { type: 'integer' },
                        page: { type: 'integer' },
                        limit: { type: 'integer' },
                        total_pages: { type: 'integer' },
                    },
                },
            },
        },
        security: [{ BearerAuth: [] }],
        tags: [
            { name: 'Auth', description: 'Authentication & user management' },
            { name: 'Couple', description: 'Couple room & pairing' },
            { name: 'Milestones', description: 'Relationship milestones' },
            { name: 'Memory', description: 'Shared memory photo' },
            { name: 'Mood', description: 'Mood tracking' },
            { name: 'Food', description: 'Food list & random picker' },
            { name: 'Wishlist', description: 'Shared wish list' },
            { name: 'Trips', description: 'Trip planning' },
        ],
    },
    apis: ['./src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
