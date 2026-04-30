const rateLimit = require('express-rate-limit');

// General API rate limiter - more lenient for cached requests
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Increased from 100 to 200 for cached requests
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    // Skip rate limiting for cached requests (marked by our middleware)
    return res.get('X-Cache-Source') === 'redis' || res.get('X-Cache-Dedupe') === 'HIT';
  }
});

// Strict limiter for expensive operations (filters, searches)
const expensiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // More restrictive for expensive operations
  message: {
    success: false,
    error: 'Too many filter/search requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    // Skip rate limiting for cached requests
    return res.get('X-Cache-Source') === 'redis' || res.get('X-Cache-Dedupe') === 'HIT';
  }
});

module.exports = {
  apiLimiter,
  expensiveLimiter
};