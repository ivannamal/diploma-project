const path = require('path');
const express = require('express');
const cors = require('cors');

const analysisRoutes = require('./routes/analysis.routes');
const fixRoutes = require('./routes/fix.routes');
const aiFixRoutes = require('./routes/aiFix.routes');
const watchRoutes = require('./routes/watch.routes');
const logger = require('./utils/logger');

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', analysisRoutes);
app.use('/api', fixRoutes);
app.use('/api', aiFixRoutes);
app.use('/api', watchRoutes);

// 404 for unknown /api routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: `Unknown API route ${req.method} ${req.path}` });
});

// centralised error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Request failed', { path: req.path, message: err.message });
  const status = err.status || 500;
  res.status(status).json({
    error: err.code || 'internal_error',
    message: err.message || 'Internal server error.',
  });
});

module.exports = app;
