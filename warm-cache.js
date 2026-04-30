// Cache warming script for popular queries
// Run this periodically to pre-populate cache

const mongoose = require('mongoose');
const redisClient = require('./src/config/redis');
const namesController = require('./src/controllers/namesController');
require('dotenv').config();

async function warmCache() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Wait for Redis connection
    await new Promise(resolve => setTimeout(resolve, 2000));

    const religions = ['islamic', 'christian', 'hindu'];
    const popularLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const popularGenders = ['Male', 'Female'];
    const popularLimits = [20, 50];

    console.log('Starting cache warming...');

    for (const religion of religions) {
      console.log(`\nWarming cache for ${religion}...`);

      // Warm filters (most important)
      try {
        await namesController.getFilters(religion);
        console.log(`  ✅ Filters cached for ${religion}`);
      } catch (error) {
        console.log(`  ❌ Filters failed for ${religion}:`, error.message);
      }

      // Warm popular letter queries
      for (const letter of popularLetters.slice(0, 10)) { // First 10 letters
        for (const limit of popularLimits) {
          try {
            await namesController.getNamesByReligion(religion, {
              startsWith: letter,
              limit,
              sort: 'popular'
            });
          } catch (error) {
            // Silent fail for cache warming
          }
        }
      }
      console.log(`  ✅ Popular letters cached for ${religion}`);

      // Warm gender-based queries
      for (const gender of popularGenders) {
        try {
          await namesController.getNamesByReligion(religion, {
            gender,
            limit: 50,
            sort: 'popular'
          });
        } catch (error) {
          // Silent fail
        }
      }
      console.log(`  ✅ Gender queries cached for ${religion}`);

      // Warm default paginated queries
      for (let page = 1; page <= 3; page++) {
        try {
          await namesController.getNamesByReligion(religion, {
            page,
            limit: 50,
            sort: 'popular'
          });
        } catch (error) {
          // Silent fail
        }
      }
      console.log(`  ✅ Paginated queries cached for ${religion}`);
    }

    // Get cache stats
    const stats = redisClient.getCacheStats();
    console.log('\n📊 Cache warming completed!');
    console.log(`Cache hit rate: ${stats.hitRate}`);
    console.log(`Redis connected: ${stats.redis.connected}`);
    console.log(`Memory cache keys: ${stats.memory.keys}`);

  } catch (error) {
    console.error('❌ Cache warming failed:', error);
  } finally {
    await mongoose.disconnect();
    await redisClient.disconnect();
  }
}

warmCache();