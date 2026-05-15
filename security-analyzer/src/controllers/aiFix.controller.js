const aiFixService = require('../services/aiFix.service');
const logger = require('../utils/logger');

async function generate(req, res) {
  const { issueId } = req.params;
  const { analysisId } = req.body || {};
  if (!analysisId || typeof analysisId !== 'string') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'analysisId is required in the request body.',
    });
  }
  try {
    const result = await aiFixService.generateFix(analysisId, issueId);
    res.json(result);
  } catch (err) {
    logger.error('AI fix generation failed', err);
    res.status(err.status || 500).json({
      error: err.code || 'ai_fix_failed',
      message: err.message,
    });
  }
}

function list(req, res) {
  const { issueId } = req.params;
  const analysisId = req.query.analysisId;
  if (!analysisId || typeof analysisId !== 'string') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'analysisId query parameter is required.',
    });
  }
  const fixes = aiFixService.listFixesForIssue(analysisId, issueId);
  res.json({ count: fixes.length, fixes });
}

async function apply(req, res) {
  const { fixId } = req.params;
  try {
    const result = await aiFixService.applyVerifiedFix(fixId);
    res.json(result);
  } catch (err) {
    logger.error('AI fix apply failed', err);
    res.status(err.status || 500).json({
      error: err.code || 'ai_fix_apply_failed',
      message: err.message,
    });
  }
}

module.exports = { generate, list, apply };
