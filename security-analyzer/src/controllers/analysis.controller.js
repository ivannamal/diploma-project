const analysisService = require('../services/analysis.service');
const reportService = require('../services/report.service');
const stateService = require('../services/state.service');
const openaiAnalysisService = require('../services/openaiAnalysis.service');
const logger = require('../utils/logger');

async function analyze(req, res) {
  const { repoUrl } = req.body || {};
  if (!repoUrl || typeof repoUrl !== 'string') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'repoUrl is required.',
    });
  }

  try {
    const analysis = await analysisService.analyzeRepository(repoUrl);
    res.json(reportService.toResponse(analysis));
  } catch (err) {
    logger.error('Analyze failed', err);
    const status = err.status || 500;
    res.status(status).json({
      error: err.code || 'analysis_failed',
      message: err.message,
    });
  }
}

function getAnalysis(req, res) {
  const { analysisId } = req.params;
  const analysis = stateService.get(analysisId);
  if (!analysis) {
    return res.status(404).json({
      error: 'not_found',
      message: 'Analysis not found or has expired.',
    });
  }
  res.json(reportService.toResponse(analysis));
}

function listAnalyses(req, res) {
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
  const items = stateService.list()
    .map((a) => reportService.toListItem(a))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, limit);
  res.json({ count: items.length, analyses: items });
}

async function analyzeWithOpenai(req, res) {
  const { repoUrl } = req.body || {};
  if (!repoUrl || typeof repoUrl !== 'string') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'repoUrl is required.',
    });
  }
  try {
    const result = await openaiAnalysisService.analyzeWithOpenai(repoUrl);
    res.json(result);
  } catch (err) {
    logger.error('OpenAI analyze failed', err);
    const status = err.status || 500;
    res.status(status).json({
      error: err.code || 'openai_analysis_failed',
      message: err.message,
    });
  }
}

module.exports = { analyze, getAnalysis, listAnalyses, analyzeWithOpenai };
