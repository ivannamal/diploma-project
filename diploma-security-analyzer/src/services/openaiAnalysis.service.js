const analysisService = require('./analysis.service');
const reportService = require('./report.service');
const openaiAgentAnalyzer = require('../agents/openaiAgentAnalyzer');
const logger = require('../utils/logger');

async function analyzeWithOpenai(repoUrl) {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OpenAI analysis is not configured. Please set OPENAI_API_KEY.');
    e.code = 'openai_not_configured';
    e.status = 400;
    throw e;
  }

  const analysis = await analysisService.analyzeRepository(repoUrl);
  const localResult = reportService.toResponse(analysis);

  let openaiResult = null;
  let openaiError = null;
  try {
    openaiResult = await openaiAgentAnalyzer.analyze(localResult);
  } catch (err) {
    logger.warn('OpenAI agent analysis failed; returning local result with error', {
      error: err.message,
    });
    openaiError = err.message;
  }

  return {
    mode: 'openai_agents',
    local_result: localResult,
    openai_result: openaiResult,
    openai_error: openaiError,
  };
}

module.exports = { analyzeWithOpenai };
