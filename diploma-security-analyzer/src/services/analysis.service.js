const crypto = require('crypto');
const { cloneRepository } = require('./repository.service');
const stateService = require('./state.service');
const staticAnalyzer = require('../analyzers/static/staticAnalyzer');
const dynamicAnalyzer = require('../analyzers/dynamic/dynamicAnalyzer');
const securityAgent = require('../agents/securityAgent');
const buildTestAgent = require('../agents/buildTestAgent');
const fixSuggestionAgent = require('../agents/fixSuggestionAgent');
const decisionAgent = require('../agents/decisionAgent');
const logger = require('../utils/logger');

function newAnalysisId() {
  return 'an_' + crypto.randomBytes(8).toString('hex');
}

function makeIssueId(analysisId, issue, idx) {
  const key = `${analysisId}:${idx}:${issue.type}:${issue.file || ''}:${issue.line || ''}:${issue.message || ''}`;
  return 'iss_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

async function analyzeRepository(repoUrl, context = null) {
  const analysisId = newAnalysisId();
  const createdAt = new Date().toISOString();
  logger.info('Analysis started', {
    analysisId,
    repoUrl,
    trigger: context?.trigger || 'manual',
    pullRequestNumber: context?.pullRequestNumber ?? null,
  });

  const { repoPath, repository } = await cloneRepository(repoUrl, analysisId);

  const [staticResult, dynamicResult] = await Promise.all([
    staticAnalyzer.analyze(repoPath),
    dynamicAnalyzer.analyze(repoPath, { analysisId }),
  ]);

  const allIssues = [
    ...staticResult.issues,
    ...dynamicResult.issues,
  ];

  // agents pass: enrich, evaluate, decide
  for (let i = 0; i < allIssues.length; i++) {
    const issue = allIssues[i];
    fixSuggestionAgent.enrich(issue);
    issue.id = makeIssueId(analysisId, issue, i);
    issue.status = issue.status || 'open';
    issue.created_at = issue.created_at || new Date().toISOString();
  }

  const securityReport = securityAgent.evaluate(staticResult.issues);
  const buildReport = buildTestAgent.evaluate(dynamicResult);
  const decision = decisionAgent.decide({
    issues: allIssues,
    security: securityReport,
    build: buildReport,
  });

  const pullRequest = context && context.pullRequestNumber != null ? {
    number: context.pullRequestNumber,
    url: context.pullRequestUrl || null,
    headSha: context.headSha || null,
    headRef: context.headRef || null,
    baseRef: context.baseRef || null,
  } : null;

  const analysis = {
    analysisId,
    repository,
    repoPath,
    createdAt,
    trigger: context?.trigger || 'manual',
    pullRequest,
    issues: allIssues,
    staticAnalysis: staticResult.summary,
    dynamicAnalysis: dynamicResult.summary,
    agents: {
      security: securityReport,
      buildTest: buildReport,
      fixSuggestion: { enrichedIssueCount: allIssues.length },
      decision,
    },
  };

  stateService.put(analysisId, analysis);
  logger.info('Analysis complete', {
    analysisId,
    decision: decision.decision,
    issueCount: allIssues.length,
  });
  return analysis;
}

module.exports = { analyzeRepository };
