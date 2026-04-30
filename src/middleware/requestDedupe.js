const crypto = require('crypto');

/**
 * Request Deduplication Middleware
 * Caches responses for identical requests within a short time window
 * to prevent duplicate function invocations from concurrent requests
 */

class RequestDeduplicator {
  constructor(ttl = 5000) { // 5 seconds default TTL
    this.cache = new Map();
    this.ttl = ttl;
  }

  /**
   * Generate hash for request
   */
  generateRequestHash(req) {
    const parts = [
      req.method,
      req.originalUrl,
      JSON.stringify(req.query || {}),
      req.method === 'POST' || req.method === 'PUT' ? JSON.stringify(req.body || {}) : ''
    ];

    return crypto.createHash('md5').update(parts.join('|')).digest('hex');
  }

  /**
   * Clean expired cache entries
   */
  cleanExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cached response
   */
  get(hash) {
    const entry = this.cache.get(hash);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(hash);
      return null;
    }

    return entry.response;
  }

  /**
   * Set cached response
   */
  set(hash, response) {
    // Clean expired entries occasionally
    if (Math.random() < 0.1) { // 10% chance to clean
      this.cleanExpired();
    }

    this.cache.set(hash, {
      response,
      timestamp: Date.now()
    });
  }
}

// Global instance
const deduplicator = new RequestDeduplicator();

/**
 * Middleware function
 */
function requestDedupe(req, res, next) {
  const hash = deduplicator.generateRequestHash(req);
  const cached = deduplicator.get(hash);

  if (cached) {
    // Return cached response
    res.set('X-Cache-Dedupe', 'HIT');
    res.status(cached.status).json(cached.body);
    return;
  }

  // Intercept response to cache it
  const originalJson = res.json;
  res.json = function(body) {
    // Cache the response
    deduplicator.set(hash, {
      status: res.statusCode,
      body: body
    });

    // Add header to indicate deduplication is active
    res.set('X-Cache-Dedupe', 'MISS');

    // Call original json method
    return originalJson.call(this, body);
  };

  next();
}

module.exports = requestDedupe;