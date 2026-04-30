const express = require('express');
const router = express.Router();
const namesController = require('../../../controllers/namesController');
const { expensiveLimiter } = require('../../../middleware/rateLimiter');

/**
 * @route   GET /api/v1/names/search
 * @desc    Search names across all or specific religion
 * @query   {string} q - Search query (required, min: 2 characters)
 * @query   {string} religion - Filter by religion: islamic, christian, hindu
 * @query   {number} limit - Number of results (default: 20, max: 50)
 * @access  Public
 */
router.get('/search', expensiveLimiter, async (req, res, next) => {
  try {
    const { q, religion, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters'
      });
    }

    // Limit search query length to prevent abuse
    const searchQuery = q.trim().substring(0, 100);
    const parsedLimit = Math.min(Math.max(1, parseInt(limit) || 20), 50);

    const result = await namesController.getNamesByReligion(religion || 'islamic', {
      search: searchQuery,
      limit: parsedLimit
    });

    // Add cache headers for search results
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('X-Cache-Source', 'redis');
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/names/:religion
 * @desc    Get paginated names by religion with optional filters
 * @param   {string} religion - Religion: islamic, christian, hindu
 * @query   {number} page - Page number (default: 1)
 * @query   {number} limit - Items per page (default: 50, max: 100)
 * @query   {string} gender - Filter by gender: male, female, unisex
 * @query   {string} origin - Filter by origin
 * @query   {string} category - Filter by category
 * @query   {string} theme - Filter by theme
 * @query   {string} startsWith - Filter names starting with letter
 * @query   {string} alphabet - Alias for startsWith
 * @query   {string} search - Search query
 * @query   {string} sort - Sort order: asc, desc, popular, trending (default: asc)
 * @access  Public
 */
router.get('/:religion', async (req, res, next) => {
  try {
    const { religion } = req.params;
    const {
      page = 1,
      limit = 50,
      gender,
      origin,
      category,
      theme,
      startsWith,
      alphabet,
      search,
      sort = 'asc'
    } = req.query;

    // Input validation and limits
    const parsedPage = Math.max(1, parseInt(page) || 1);
    const parsedLimit = Math.min(Math.max(1, parseInt(limit) || 50), 100); // 1-100 range

    // Prevent excessive pagination
    if (parsedPage > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Page number too high. Use search or filters instead.'
      });
    }

    const result = await namesController.getNamesByReligion(religion, {
      page: parsedPage,
      limit: parsedLimit,
      gender,
      origin,
      category,
      theme,
      startsWith: startsWith || alphabet,
      search,
      sort
    });

    // Add cache headers for filtered lists - cache for 10 minutes
    res.set('Cache-Control', 'public, max-age=600');
    res.set('X-Cache-Source', 'redis');
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/names/:religion/filters
 * @desc    Get available filters for a religion (genders, origins, letters)
 * @param   {string} religion - Religion: islamic, christian, hindu
 * @access  Public
 */
router.get('/:religion/filters', expensiveLimiter, async (req, res, next) => {
  try {
    const result = await namesController.getFilters(req.params.religion);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/names/:religion/letter/:letter
 * @desc    Get names starting with a specific letter
 * @param   {string} religion - Religion: islamic, christian, hindu
 * @param   {string} letter - Starting letter
 * @query   {number} limit - Number of results (default: 100, max: 150)
 * @access  Public
 */
router.get('/:religion/letter/:letter', async (req, res, next) => {
  try {
    const { religion, letter } = req.params;
    const { limit = 100 } = req.query;

    const result = await namesController.getNamesByLetter(
      religion,
      letter.toUpperCase(),
      Math.min(parseInt(limit) || 100, 150)
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/names/:religion/:slug/related
 * @desc    Get related names based on origin and gender
 * @param   {string} religion - Religion: islamic, christian, hindu
 * @param   {string} slug - Name slug
 * @query   {number} limit - Number of results (default: 10, max: 20)
 * @access  Public
 */
router.get('/:religion/:slug/related', async (req, res, next) => {
  try {
    const { religion, slug } = req.params;
    const { limit = 10 } = req.query;

    const result = await namesController.getRelatedNames(
      religion,
      slug,
      Math.min(parseInt(limit) || 10, 20)
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/names/:religion/:slug/similar
 * @desc    Get similar names based on name pattern
 * @param   {string} religion - Religion: islamic, christian, hindu
 * @param   {string} slug - Name slug
 * @query   {number} limit - Number of results (default: 8, max: 20)
 * @access  Public
 */
router.get('/:religion/:slug/similar', async (req, res, next) => {
  try {
    const { religion, slug } = req.params;
    const { limit = 8 } = req.query;

    const result = await namesController.getSimilarNames(
      religion,
      slug,
      Math.min(parseInt(limit) || 8, 20)
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/names/:religion/:slug
 * @desc    Get single name by religion and slug
 * @param   {string} religion - Religion: islamic, christian, hindu
 * @param   {string} slug - Name slug
 * @access  Public
 */
router.get('/:religion/:slug', async (req, res, next) => {
  try {
    const { religion, slug } = req.params;
    const result = await namesController.getNameBySlug(religion, slug);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/names
 * @desc    Get paginated list of names with optional filters
 * @query   {string} religion - Religion: islamic, christian, hindu (default: islamic)
 * @query   {number} page - Page number (default: 1)
 * @query   {number} limit - Items per page (default: 50, max: 100)
 * @query   {string} gender - Filter by gender: male, female
 * @query   {string} origin - Filter by origin
 * @query   {string} startsWith - Filter names starting with letter
 * @query   {string} search - Search query
 * @query   {string} sort - Sort order: asc, desc (default: asc)
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const {
      religion = 'islamic',
      page = 1,
      limit = 50,
      gender,
      origin,
      startsWith,
      search,
      sort = 'asc'
    } = req.query;

    const result = await namesController.getNamesByReligion(religion, {
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 50, 100),
      gender,
      origin,
      startsWith,
      search,
      sort
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
