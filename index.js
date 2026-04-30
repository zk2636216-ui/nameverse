const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const dotenv = require('dotenv');

// Load environment variables from .env if present
dotenv.config({ path: path.join(__dirname, '.env') });

const { connectDB } = require('./src/config/database');
const apiV1Router = require('./src/routes/api/v1');
const errorHandler = require('./src/middleware/errorHandler');
const requestDedupe = require('./src/middleware/requestDedupe');
const { apiLimiter } = require('./src/middleware/rateLimiter');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors({ origin: '*', credentials: false }));

// Enhanced compression with better settings
app.use(compression({
  level: 6, // Good balance between speed and compression
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress if client doesn't support it
    if (!req.headers['accept-encoding']) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json({ limit: '1mb' })); // Reduced from 10mb for security
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request deduplication middleware (before rate limiting)
app.use('/api', requestDedupe);

// Rate limiting (after deduplication so cached requests bypass limits)
app.use('/api', apiLimiter);

app.use(morgan('combined'));

app.use('/api/v1', apiV1Router);

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Nameverse backend is running',
    version: '1.0.0'
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

app.use(errorHandler);

module.exports = app;

if (require.main === module) {
  connectDB()
    .then(() => {
      app.listen(port, () => {
        console.log(`Nameverse API running on port ${port}`);
      });
    })
    .catch((error) => {
      console.error('Failed to connect to MongoDB:', error.message);
      process.exit(1);
    });
}