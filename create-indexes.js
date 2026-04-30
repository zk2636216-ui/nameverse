// Database index creation script
// Run this once to optimize query performance

const mongoose = require('mongoose');
require('dotenv').config();

async function createIndexes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const db = mongoose.connection.db;
    const collections = ['islamic_names', 'christian_names', 'hindu_names'];

    for (const collectionName of collections) {
      console.log(`Creating indexes for ${collectionName}...`);

      const collection = db.collection(collectionName);

      // Compound index for filtered searches
      await collection.createIndex({
        gender: 1,
        origin: 1,
        category: 1,
        name: 1,
        popularity: -1
      }, { name: 'filtered_search_idx' });

      // Text index for search queries
      await collection.createIndex({
        name: 'text',
        meaning: 'text',
        origin: 'text'
      }, { name: 'text_search_idx' });

      // Slug index for lookups
      await collection.createIndex({ slug: 1 }, { name: 'slug_idx', unique: true });

      // Theme array index
      await collection.createIndex({ themes: 1 }, { name: 'themes_idx' });

      // Category array index
      await collection.createIndex({ category: 1 }, { name: 'category_idx' });

      console.log(`✅ Indexes created for ${collectionName}`);
    }

    console.log('🎉 All indexes created successfully!');
  } catch (error) {
    console.error('❌ Error creating indexes:', error);
  } finally {
    await mongoose.disconnect();
  }
}

createIndexes();