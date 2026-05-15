const fixService = require('../services/fix.service');
const stateService = require('../services/state.service');
const logger = require('../utils/logger');

async function applyFix(req, res) {
  const { issueId } = req.params;
  const { analysisId } = req.body || {};
  if (!analysisId || typeof analysisId !== 'string') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'analysisId is required in the request body.',
    });
  }

  try {
    const result = await fixService.applyFix(analysisId, issueId);
    res.json(result);
  } catch (err) {
    logger.error('Apply fix failed', err);
    const status = err.status || 500;
    res.status(status).json({
      error: err.code || 'fix_failed',
      message: err.message,
    });
  }
}

function ignore(req, res) {
  const { issueId } = req.params;
  const { analysisId } = req.body || {};
  if (!analysisId || typeof analysisId !== 'string') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'analysisId is required in the request body.',
    });
  }

  const issue = stateService.markIssueStatus(analysisId, issueId, 'ignored');
  if (!issue) {
    return res.status(404).json({
      error: 'not_found',
      message: 'Issue not found in the given analysis.',
    });
  }

  res.json({
    issueId,
    status: 'ignored',
    message: 'Issue ignored in current analysis session.',
  });
}

module.exports = { applyFix, ignore };
