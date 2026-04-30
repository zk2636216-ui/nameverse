const logger = require('../utils/logger');
const redisClient = require('../config/redis');
const IslamicModel = require('../../models/IslamicModel');
const ChristianModel = require('../../models/ChristianModel');
const HinduModel = require('../../models/HinduModel');

// Model mapping
const models = {
  islamic: IslamicModel,
  christian: ChristianModel,
  hindu: HinduModel
};

/**
 * Cache key generation utilities
 */
const generateNamesListKey = (religion, options) => {
  const {
    limit = 20,
    page = 1,
    sort = 'asc',
    gender,
    origin,
    category,
    theme,
    search,
    startsWith
  } = options;

  // Create a stable key from parameters
  const keyParts = [
    'names',
    religion,
    `limit:${limit}`,
    `page:${page}`,
    `sort:${sort}`,
    gender ? `gender:${gender}` : '',
    origin ? `origin:${origin}` : '',
    category ? `category:${category}` : '',
    theme ? `theme:${theme}` : '',
    search ? `search:${search}` : '',
    startsWith ? `startsWith:${startsWith}` : ''
  ].filter(Boolean);

  return keyParts.join(':').toLowerCase().replace(/\s+/g, '_');
};

const generateNameKey = (religion, slug) => `name:${religion}:${slug}`;

const generateFiltersKey = (religion) => `filters:${religion}`;

const generateRelatedKey = (religion, slug, limit) => `related:${religion}:${slug}:${limit}`;

const generateSimilarKey = (religion, slug, limit) => `similar:${religion}:${slug}:${limit}`;

/**
 * Get names by religion with filtering and pagination
 */
// List of words that if found in any category, the name should be excluded
// Can be overridden via options.excludeCategoryWords
const DEFAULT_EXCLUDED_CATEGORY_WORDS = ['adult'];

const getNamesByReligion = async (religion, options = {}) => {
  const {
    limit = 20,
    page = 1,
    sort = 'asc',
    gender,
    origin,
    category,
    theme,
    search,
    startsWith,
    length,
    popularity,
    trending,
    excludeCategoryWords
  } = options;

  const Model = models[religion.toLowerCase()];
  if (!Model) {
    throw new Error(`Invalid religion: ${religion}`);
  }

  // Input validation and parsing
  let parsedCategory = null;
  if (category && category.trim() !== '') {
    try {
      const decodedCategory = decodeURIComponent(category);
      const categoryWords = decodedCategory.split(/[,\s]+/).map(w => w.trim()).filter(w => w.length > 0);
      const uniqueWords = [...new Set(categoryWords.map(w => w.toLowerCase()))];
      if (uniqueWords.length === 0 || uniqueWords.length > 3) {
        throw new Error('Category filter must contain 1-3 unique words');
      }
      parsedCategory = uniqueWords; // Use lowercase unique words for filtering
    } catch (error) {
      if (error.message.includes('URI malformed')) {
        throw new Error('Invalid category encoding');
      }
      throw error;
    }
  }

  if (gender && gender.trim() !== '') {
    if (/\s|,/.test(gender)) {
      throw new Error('Gender filter must be a single word');
    }
  }

  const skip = (page - 1) * limit;
  const filterQuery = {};
  const excludeWords = excludeCategoryWords || DEFAULT_EXCLUDED_CATEGORY_WORDS;

  // Apply category word exclusion: if any category contains excluded words, filter out the name
  if (excludeWords && excludeWords.length > 0) {
    const wordConditions = excludeWords.map(word => ({
      category: { $not: { $regex: `\\b${word}\\b`, $options: 'i' } }
    }));
    // If category field exists and is not empty, exclude names with forbidden words
    filterQuery.$and = filterQuery.$and || [];
    filterQuery.$and.push({
      $or: [
        { category: { $exists: false } },
        { category: { $size: 0 } },
        { $and: wordConditions }
      ]
    });
  }

  // Apply filters
  if (gender && gender.trim() !== '') {
    // Use regex to match gender flexibly (e.g., "Male" matches "(Male)" or "Male/Female")
    filterQuery.gender = { $regex: `\\b${gender}\\b`, $options: 'i' };
  }

  if (parsedCategory && parsedCategory.length > 0) {
    // Category is an array, match documents where category contains all specified words
    filterQuery.$and = filterQuery.$and || [];
    parsedCategory.forEach(word => {
      filterQuery.$and.push({
        category: { $regex: `\\b${word}\\b`, $options: 'i' }
      });
    });
  }

  if (theme && theme.trim() !== '') {
    filterQuery.themes = { $regex: theme, $options: 'i' };
  }

  if (search && search.trim() !== '') {
    filterQuery.$or = [
      { name: { $regex: search, $options: 'i' } },
      { meaning: { $regex: search, $options: 'i' } },
      { origin: { $regex: search, $options: 'i' } }
    ];
  }

  if (origin && origin.trim() !== '') {
    filterQuery.origin = { $regex: origin, $options: 'i' };
  }

  if (startsWith && startsWith.trim() !== '') {
    filterQuery.name = { $regex: `^${startsWith}`, $options: 'i' };
  }

  if (length && length.trim() !== '') {
    const [min, max] = length.split('-').map(Number);
    if (max) {
      filterQuery.$expr = {
        $and: [
          { $gte: [{ $strLenCP: '$name' }, min] },
          { $lte: [{ $strLenCP: '$name' }, max] }
        ]
      };
    } else {
      filterQuery.$expr = { $eq: [{ $strLenCP: '$name' }, min] };
    }
  }

  if (popularity && popularity.trim() !== '') {
    const popValue = Number(popularity);
    if (popValue) {
      filterQuery.popularity = { $gte: popValue };
    }
  }

  if (trending && trending.toLowerCase() === 'true') {
    filterQuery.trending = true;
  }

  // Sorting logic
  let sortQuery = {};
  switch (sort.toLowerCase()) {
    case 'desc':
    case 'z-a':
      sortQuery = { name: -1 };
      break;
    case 'popular':
    case 'popularity':
      sortQuery = { popularity: -1, name: 1 };
      break;
    case 'trending':
      sortQuery = { trending: -1, popularity: -1, name: 1 };
      break;
    case 'length-asc':
      sortQuery = { nameLength: 1, name: 1 };
      break;
    case 'length-desc':
      sortQuery = { nameLength: -1, name: 1 };
      break;
    case 'newest':
      sortQuery = { createdAt: -1 };
      break;
    case 'oldest':
      sortQuery = { createdAt: 1 };
      break;
    case 'asc':
    case 'a-z':
    default:
      sortQuery = { name: 1 };
      break;
  }

  // Use cache-aside pattern with 10-minute TTL for filtered results
  const ttl = 600; // 10 minutes
  const cacheKey = generateNamesListKey(religion, options);

  const result = await redisClient.getOrSet(cacheKey, async () => {
    // Add query timeout protection
    const queryTimeout = setTimeout(() => {
      throw new Error('Query timeout exceeded');
    }, 10000); // 10 second timeout

    try {
      const [names, totalCount, filteredCount] = await Promise.all([
        Model.find(filterQuery)
          .sort(sortQuery)
          .skip(skip)
          .limit(Math.min(limit, 100)) // Enforce hard limit
          .lean()
          .maxTimeMS(8000), // 8 second query timeout
        Model.countDocuments().maxTimeMS(3000),
        Model.countDocuments(filterQuery).maxTimeMS(5000)
      ]);

      clearTimeout(queryTimeout);

      return {
        success: true,
        religion,
        pagination: {
          page,
          limit,
          totalPages: Math.ceil(filteredCount / limit),
          totalCount: filteredCount,
          hasMore: skip + names.length < filteredCount
        },
        filtersApplied: {
          gender: gender || null,
          origin: origin || null,
          category: category || null,
          theme: theme || null,
          search: search || null,
          startsWith: startsWith || null,
          length: length || null,
          popularity: popularity || null,
          trending: trending || null,
          sort
        },
        count: names.length,
        data: names
      };
    } catch (error) {
      clearTimeout(queryTimeout);
      logger.error('Error in getNamesByReligion:', error);
      throw error;
    }
  }, ttl);

  return result.data;
}

/**
 * Get a specific name by religion and slug
 */
const getNameBySlug = async (religion, slug) => {
  const Model = models[religion.toLowerCase()];
  if (!Model) {
    throw new Error(`Invalid religion: ${religion}`);
  }

  // Input validation
  if (!slug || typeof slug !== 'string' || slug.length > 200) {
    return null;
  }

  // Generate cache key
  const cacheKey = generateNameKey(religion, slug);

  // Use cache-aside pattern with 30-minute TTL for individual names
  const ttl = 1800; // 30 minutes

  const result = await redisClient.getOrSet(cacheKey, async () => {
    // ✅ FIX: Multi method slug lookup, case insensitive
    let name = await Model.findOne({ slug: slug.toLowerCase() }).lean();
    if (!name) name = await Model.findOne({ slug }).lean();
    if (!name) name = await Model.findOne({ slug: new RegExp(`^${slug}$`, 'i') }).lean();
    if (!name) name = await Model.findOne({ name: new RegExp(`^${slug}$`, 'i') }).lean();

    if (!name) {
      return null;
    }

    return {
      success: true,
      data: name
    };
  }, ttl);

  return result.data;
};

/**
 * Get names by first letter - TEMPORARY FAST VERSION
 */
const getNamesByLetter = async (religion, letter, options = {}) => {
  const { limit = 10 } = options;
  
  // Temporary hardcoded data to avoid database timeout issues
  const sampleData = {
    'A': [
      { name: 'Ali', meaning: 'The high', origin: 'Arabic', gender: 'Male', popularity: 85, slug: 'ali' },
      { name: 'Aisha', meaning: 'Living', origin: 'Arabic', gender: 'Female', popularity: 78, slug: 'aisha' },
      { name: 'Adam', meaning: 'Man', origin: 'Hebrew', gender: 'Male', popularity: 92, slug: 'adam' },
      { name: 'Abdullah', meaning: 'Servant of God', origin: 'Arabic', gender: 'Male', popularity: 75, slug: 'abdullah' },
      { name: 'Amina', meaning: 'Trustworthy', origin: 'Arabic', gender: 'Female', popularity: 82, slug: 'amina' }
    ],
    'B': [
      { name: 'Bilal', meaning: 'Moistening', origin: 'Arabic', gender: 'Male', popularity: 65, slug: 'bilal' },
      { name: 'Bakr', meaning: 'Young camel', origin: 'Arabic', gender: 'Male', popularity: 58, slug: 'bakr' },
      { name: 'Barakah', meaning: 'Blessing', origin: 'Arabic', gender: 'Female', popularity: 62, slug: 'barakah' }
    ],
    'C': [
      { name: 'Christopher', meaning: 'Christ-bearer', origin: 'Greek', gender: 'Male', popularity: 88, slug: 'christopher' },
      { name: 'Christian', meaning: 'Follower of Christ', origin: 'Latin', gender: 'Male', popularity: 85, slug: 'christian' }
    ],
    'D': [
      { name: 'David', meaning: 'Beloved', origin: 'Hebrew', gender: 'Male', popularity: 95, slug: 'david' },
      { name: 'Daniel', meaning: 'God is my judge', origin: 'Hebrew', gender: 'Male', popularity: 90, slug: 'daniel' }
    ],
    'E': [
      { name: 'Elijah', meaning: 'My God is Yahweh', origin: 'Hebrew', gender: 'Male', popularity: 87, slug: 'elijah' },
      { name: 'Elizabeth', meaning: 'God is my oath', origin: 'Hebrew', gender: 'Female', popularity: 89, slug: 'elizabeth' }
    ],
    'F': [
      { name: 'Fatima', meaning: 'To abstain', origin: 'Arabic', gender: 'Female', popularity: 88, slug: 'fatima' },
      { name: 'Faisal', meaning: 'Decisive', origin: 'Arabic', gender: 'Male', popularity: 72, slug: 'faisal' }
    ],
    'G': [
      { name: 'Gabriel', meaning: 'God is my strength', origin: 'Hebrew', gender: 'Male', popularity: 91, slug: 'gabriel' },
      { name: 'George', meaning: 'Farmer', origin: 'Greek', gender: 'Male', popularity: 83, slug: 'george' }
    ],
    'H': [
      { name: 'Hassan', meaning: 'Handsome', origin: 'Arabic', gender: 'Male', popularity: 86, slug: 'hassan' },
      { name: 'Hussein', meaning: 'Handsome', origin: 'Arabic', gender: 'Male', popularity: 84, slug: 'hussein' }
    ],
    'I': [
      { name: 'Isaac', meaning: 'He will laugh', origin: 'Hebrew', gender: 'Male', popularity: 88, slug: 'isaac' },
      { name: 'Ibrahim', meaning: 'Father of nations', origin: 'Arabic', gender: 'Male', popularity: 92, slug: 'ibrahim' }
    ],
    'J': [
      { name: 'Joseph', meaning: 'He will add', origin: 'Hebrew', gender: 'Male', popularity: 93, slug: 'joseph' },
      { name: 'Jesus', meaning: 'God saves', origin: 'Hebrew', gender: 'Male', popularity: 98, slug: 'jesus' }
    ],
    'K': [
      { name: 'Khadija', meaning: 'Premature child', origin: 'Arabic', gender: 'Female', popularity: 81, slug: 'khadija' },
      { name: 'Khalid', meaning: 'Eternal', origin: 'Arabic', gender: 'Male', popularity: 79, slug: 'khalid' }
    ],
    'L': [
      { name: 'Luke', meaning: 'Light-giving', origin: 'Greek', gender: 'Male', popularity: 85, slug: 'luke' },
      { name: 'Laila', meaning: 'Night', origin: 'Arabic', gender: 'Female', popularity: 76, slug: 'laila' }
    ],
    'M': [
      { name: 'Muhammad', meaning: 'Praised', origin: 'Arabic', gender: 'Male', popularity: 99, slug: 'muhammad' },
      { name: 'Mary', meaning: 'Bitter', origin: 'Hebrew', gender: 'Female', popularity: 94, slug: 'mary' },
      { name: 'Moses', meaning: 'Drawn out', origin: 'Hebrew', gender: 'Male', popularity: 96, slug: 'moses' }
    ],
    'N': [
      { name: 'Noah', meaning: 'Rest', origin: 'Hebrew', gender: 'Male', popularity: 97, slug: 'noah' },
      { name: 'Nora', meaning: 'Light', origin: 'Arabic', gender: 'Female', popularity: 74, slug: 'nora' }
    ],
    'O': [
      { name: 'Omar', meaning: 'Flourishing', origin: 'Arabic', gender: 'Male', popularity: 87, slug: 'omar' },
      { name: 'Oliver', meaning: 'Olive tree', origin: 'Latin', gender: 'Male', popularity: 89, slug: 'oliver' }
    ],
    'P': [
      { name: 'Peter', meaning: 'Rock', origin: 'Greek', gender: 'Male', popularity: 91, slug: 'peter' },
      { name: 'Paul', meaning: 'Small', origin: 'Latin', gender: 'Male', popularity: 86, slug: 'paul' }
    ],
    'Q': [
      { name: 'Qasim', meaning: 'Divider', origin: 'Arabic', gender: 'Male', popularity: 63, slug: 'qasim' },
      { name: 'Qadir', meaning: 'Capable', origin: 'Arabic', gender: 'Male', popularity: 68, slug: 'qadir' }
    ],
    'R': [
      { name: 'Rachel', meaning: 'Ewe', origin: 'Hebrew', gender: 'Female', popularity: 84, slug: 'rachel' },
      { name: 'Rashid', meaning: 'Rightly guided', origin: 'Arabic', gender: 'Male', popularity: 77, slug: 'rashid' }
    ],
    'S': [
      { name: 'Sarah', meaning: 'Princess', origin: 'Hebrew', gender: 'Female', popularity: 92, slug: 'sarah' },
      { name: 'Solomon', meaning: 'Peace', origin: 'Hebrew', gender: 'Male', popularity: 94, slug: 'solomon' },
      { name: 'Suleiman', meaning: 'Peace', origin: 'Arabic', gender: 'Male', popularity: 90, slug: 'suleiman' }
    ],
    'T': [
      { name: 'Thomas', meaning: 'Twin', origin: 'Aramaic', gender: 'Male', popularity: 85, slug: 'thomas' },
      { name: 'Talha', meaning: 'Fruit tree', origin: 'Arabic', gender: 'Male', popularity: 71, slug: 'talha' }
    ],
    'U': [
      { name: 'Umar', meaning: 'Flourishing', origin: 'Arabic', gender: 'Male', popularity: 88, slug: 'umar' },
      { name: 'Uthman', meaning: 'Baby bustard', origin: 'Arabic', gender: 'Male', popularity: 80, slug: 'uthman' }
    ],
    'V': [
      { name: 'Victoria', meaning: 'Victory', origin: 'Latin', gender: 'Female', popularity: 87, slug: 'victoria' },
      { name: 'Vincent', meaning: 'Conquering', origin: 'Latin', gender: 'Male', popularity: 79, slug: 'vincent' }
    ],
    'W': [
      { name: 'William', meaning: 'Resolute protection', origin: 'Germanic', gender: 'Male', popularity: 93, slug: 'william' },
      { name: 'Wahid', meaning: 'One', origin: 'Arabic', gender: 'Male', popularity: 66, slug: 'wahid' }
    ],
    'X': [
      { name: 'Xavier', meaning: 'New house', origin: 'Basque', gender: 'Male', popularity: 73, slug: 'xavier' }
    ],
    'Y': [
      { name: 'Yusuf', meaning: 'God will add', origin: 'Arabic', gender: 'Male', popularity: 91, slug: 'yusuf' },
      { name: 'Yahya', meaning: 'God is gracious', origin: 'Arabic', gender: 'Male', popularity: 83, slug: 'yahya' }
    ],
    'Z': [
      { name: 'Zachary', meaning: 'God remembers', origin: 'Hebrew', gender: 'Male', popularity: 84, slug: 'zachary' },
      { name: 'Zainab', meaning: 'Fragrant flower', origin: 'Arabic', gender: 'Female', popularity: 78, slug: 'zainab' },
      { name: 'Zayed', meaning: 'To grow', origin: 'Arabic', gender: 'Male', popularity: 70, slug: 'zayed' }
    ]
  };

  const letterUpper = letter.toUpperCase();
  const names = sampleData[letterUpper] || [];

  return {
    success: true,
    religion,
    letter: letterUpper,
    count: names.length,
    data: names.slice(0, limit),
    message: 'Showing sample data - database optimization in progress'
  };
};

/**
 * Get related names
 */
const getRelatedNames = async (religion, slug) => {
  const Model = models[religion.toLowerCase()];
  if (!Model) {
    throw new Error(`Invalid religion: ${religion}`);
  }

  try {
    const currentName = await Model.findOne({ slug }).lean();
    if (!currentName) {
      return {
        success: true,
        data: [],
        count: 0
      };
    }

    // Find names with similar origin or meaning
    const relatedNames = await Model
      .find({
        _id: { $ne: currentName._id },
        $or: [
          { origin: currentName.origin },
          { gender: currentName.gender }
        ]
      })
      .limit(10)
      .sort({ popularity: -1, name: 1 })
      .lean();

    return {
      success: true,
      religion,
      originalName: currentName.name,
      count: relatedNames.length,
      data: relatedNames
    };
  } catch (error) {
    logger.error('Error in getRelatedNames:', error);
    throw error;
  }
};

/**
 * Get similar names based on string similarity
 */
const getSimilarNames = async (religion, slug) => {
  const Model = models[religion.toLowerCase()];
  if (!Model) {
    throw new Error(`Invalid religion: ${religion}`);
  }

  try {
    const currentName = await Model.findOne({ slug }).lean();
    if (!currentName) {
      return {
        success: true,
        data: [],
        count: 0
      };
    }

    // Simple similarity based on name length and starting character
    const nameLength = currentName.name.length;
    const startsWith = currentName.name[0].toLowerCase();

    const similarNames = await Model
      .find({
        _id: { $ne: currentName._id },
        name: { $regex: `^${startsWith}`, $options: 'i' },
        $expr: {
          $and: [
            { $gte: [{ $strLenCP: '$name' }, nameLength - 2] },
            { $lte: [{ $strLenCP: '$name' }, nameLength + 2] }
          ]
        }
      })
      .limit(8)
      .sort({ popularity: -1, name: 1 })
      .lean();

    return {
      success: true,
      religion,
      originalName: currentName.name,
      count: similarNames.length,
      data: similarNames
    };
  } catch (error) {
    logger.error('Error in getSimilarNames:', error);
    throw error;
  }
};

/**
 * Build a MongoDB match stage to exclude names whose category contains forbidden words
 */
const buildCategoryExclusionMatch = (excludeWords = DEFAULT_EXCLUDED_CATEGORY_WORDS) => {
  if (!excludeWords || excludeWords.length === 0) return null;
  const wordConditions = excludeWords.map(word => ({
    category: { $not: { $regex: `\\b${word}\\b`, $options: 'i' } }
  }));
  return {
    $match: {
      $or: [
        { category: { $exists: false } },
        { category: { $size: 0 } },
        { $and: wordConditions }
      ]
    }
  };
};

/**
 * Normalize a filter value: remove brackets, punctuation, and extra spacing
 */
const FILTER_NORMALIZATION_STOPWORDS = new Set([
  'of', 'the', 'and', 'or', 'in', 'on', 'with', 'for', 'from', 'by', 'to',
  'a', 'an', 'is', 'are', 'was', 'were', 'this', 'that', 'these', 'those',
  'name', 'names', 'origin', 'language', 'meaning', 'derived', 'used',
  'based', 'possible', 'potentially', 'may', 'not', 'any', 'specific',
  'source', 'sources', 'term', 'terms', 'word', 'words', 'including',
  'meaningful', 'meaningful', 'culture', 'religion', 'religious', 'ancient',
  'modern', 'historical', 'classical', 'western', 'spiritual', 'biblical',
  'christian', 'islamic', 'hindu', 'roman', 'greek', 'latin'
]);
const FILTER_NORMALIZATION_KEYWORDS = [
  'Arabic', 'Hebrew', 'Greek', 'Latin', 'French', 'German', 'Spanish',
  'English', 'African', 'American', 'Celtic', 'Irish', 'Scottish',
  'Welsh', 'Scandinavian', 'Norse', 'Japanese', 'Chinese', 'Korean',
  'Italian', 'Russian', 'Portuguese', 'Polish', 'Turkish', 'Persian',
  'Aramaic', 'Sanskrit', 'Hindu', 'Islamic', 'Muslim', 'Jewish',
  'Hebrew', 'Egyptian', 'Roman', 'British', 'Icelandic', 'Nigerian',
  'Yoruba', 'Swahili', 'Zulu', 'Kikuyu', 'Vietnamese', 'Thai', 'Greek',
  'Biblical', 'Saint', 'Modern', 'Ancient', 'Nature', 'Fantasy',
  'Historical', 'City', 'Country'
];

const extractFilterToken = (raw) => {
  if (!raw || !raw.trim()) return null;
  const cleaned = raw
    .replace(/[()[\]{}]/g, ' ')
    .replace(/['"“”‘’]/g, ' ')
    .replace(/[.,;:?]/g, ' ')
    .replace(/\s*[-/]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  const keyword = FILTER_NORMALIZATION_KEYWORDS.find(keyword =>
    new RegExp(`\\b${keyword}\\b`, 'i').test(cleaned)
  );
  if (keyword) return keyword;

  const segments = cleaned.split(/\b(?:or|and)\b/i).map(s => s.trim()).filter(Boolean);
  const candidate = segments.length ? segments[0] : cleaned;

  const words = candidate.split(/\s+/g).filter(word => word && !FILTER_NORMALIZATION_STOPWORDS.has(word.toLowerCase()));
  if (words.length === 0) return null;

  return words[0].replace(/[^\p{L}\p{N}-]/gu, '').trim() || null;
};

const normalizeFilterValue = (val) => {
  if (!val || !val.trim()) return null;
  return extractFilterToken(val);
};

/**
 * Get filter options for a specific religion.
 * Returns normalized origin and category values and includes all category filters.
 * Applies category word exclusion (e.g. 'adult') so excluded names do not count toward filter totals.
 */
const getFilters = async (religion) => {
  const Model = models[religion.toLowerCase()];
  if (!Model) {
    throw new Error(`Invalid religion: ${religion}`);
  }

  try {
    const exclusionStage = buildCategoryExclusionMatch();

    // Use Promise.all to run aggregations in parallel for better performance
    const [
      lettersResults,
      gendersRaw,
      originsRaw,
      themesRaw,
      categoriesRaw,
      total_names
    ] = await Promise.all([
      // --- Letters (first character of name) ---
      Model.aggregate([
        ...(exclusionStage ? [exclusionStage] : []),
        { $project: { firstLetter: { $substrCP: ["$name", 0, 1] } } },
        { $group: { _id: "$firstLetter", count: { $sum: 1 } } },
        { $match: { count: { $gt: 100 } } },
        { $sort: { _id: 1 } }
      ]).maxTimeMS(5000), // 5 second timeout

      // --- Genders ---
      Model.aggregate([
        ...(exclusionStage ? [exclusionStage] : []),
        { $match: { gender: { $exists: true, $ne: null, $ne: "" } } },
        { $group: { _id: "$gender", count: { $sum: 1 } } },
        { $match: { count: { $gt: 100 } } },
        { $sort: { _id: 1 } }
      ]).maxTimeMS(5000),

      // --- Origins ---
      Model.aggregate([
        ...(exclusionStage ? [exclusionStage] : []),
        { $match: { origin: { $exists: true, $ne: null, $ne: "" } } },
        { $group: { _id: "$origin", count: { $sum: 1 } } },
        { $match: { count: { $gt: 50 } } },
        { $sort: { _id: 1 } }
      ]).maxTimeMS(5000),

      // --- Themes ---
      Model.aggregate([
        ...(exclusionStage ? [exclusionStage] : []),
        { $match: { themes: { $exists: true, $ne: [] } } },
        { $unwind: "$themes" },
        { $group: { _id: "$themes", count: { $sum: 1 } } },
        { $match: { count: { $gt: 100 } } },
        { $sort: { _id: 1 } }
      ]).maxTimeMS(5000),

      // --- Categories ---
      Model.aggregate([
        ...(exclusionStage ? [exclusionStage] : []),
        { $match: { category: { $exists: true, $ne: [] } } },
        { $unwind: "$category" },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).maxTimeMS(5000),

      // Get total names count (excluding filtered ones)
      Model.countDocuments(exclusionStage ? exclusionStage.$match : {}).maxTimeMS(3000)
    ]);

    // Process letters
    const letters = lettersResults
      .map(r => r._id)
      .filter(l => l && /^\p{L}$/u.test(l))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Process genders
    const gendersMap = new Map();
    gendersRaw.forEach(r => {
      const cleaned = normalizeFilterValue(r._id);
      if (!cleaned) return;
      const normalized = cleaned.toLowerCase();
      if (!gendersMap.has(normalized)) {
        gendersMap.set(normalized, cleaned);
      }
    });
    const genders = Array.from(gendersMap.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Process origins
    const originsMap = new Map();
    originsRaw.forEach(r => {
      const cleaned = normalizeFilterValue(r._id);
      if (!cleaned) return;
      const normalized = cleaned.toLowerCase();
      if (!originsMap.has(normalized)) {
        originsMap.set(normalized, cleaned);
      }
    });
    const origins = Array.from(originsMap.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Process themes
    const themesMap = new Map();
    themesRaw.forEach(r => {
      const cleaned = normalizeFilterValue(r._id);
      if (!cleaned) return;
      const normalized = cleaned.toLowerCase();
      if (!themesMap.has(normalized)) {
        themesMap.set(normalized, cleaned);
      }
    });
    const themes = Array.from(themesMap.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Process categories
    const categoriesMap = new Map();
    categoriesRaw.forEach(r => {
      const cleaned = normalizeFilterValue(r._id);
      if (!cleaned) return;
      const normalized = cleaned.toLowerCase();
      if (!categoriesMap.has(normalized)) {
        categoriesMap.set(normalized, cleaned);
      }
    });
    const categories = Array.from(categoriesMap.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    return {
      success: true,
      religion,
      data: {
        letters,
        genders,
        origins,
        themes,
        categories,
        total_names
      }
    };
  } catch (error) {
    logger.error('Error in getFilters:', error);
    throw error;
  }
};

module.exports = {
  getNamesByReligion,
  getNameBySlug,
  getNamesByLetter,
  getRelatedNames,
  getSimilarNames,
  getFilters
};
