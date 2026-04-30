const express = require('express');
const router = express.Router();
const redisClient = require('../../../config/redis');

/**
 * Cache monitoring endpoint
 * GET /api/v1/cache/stats
 */
router.get('/stats', (req, res) => {
  try {
    const stats = redisClient.getCacheStats();

    res.json({
      success: true,
      message: 'Cache statistics retrieved',
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve cache statistics',
      message: error.message
    });
  }
});

/**
 * Cache flush endpoint (admin only - should be protected in production)
 * POST /api/v1/cache/flush
 */
router.post('/flush', async (req, res) => {
  try {
    await redisClient.flushAll();

    res.json({
      success: true,
      message: 'Cache flushed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to flush cache',
      message: error.message
    });
  }
});

module.exports = router;