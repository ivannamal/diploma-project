const decisionAgent = require('../agents/decisionAgent');

// recompute the decision from the current state so that
// ignored/fixed issues update
function summarize(analysis) {
  const active = analysis.issues.filter((i) => i.status !== 'ignored' && i.status !== 'fixed');
  const fixable = active.filter((i) => i.fix && i.fix.available && i.fix.safe);
  const recalculated = decisionAgent.decide({
    issues: analysis.issues,
    security: analysis.agents.security,
    build: analysis.agents.buildTest,
  });

  return {
    decision: recalculated.decision,
    risk_level: recalculated.risk_level,
    checkedFiles: analysis.staticAnalysis.checkedFiles || 0,
    issueCount: active.length,
    fixableIssueCount: fixable.length,
    dynamicStatus: analysis.dynamicAnalysis.status || 'skipped',
  };
}

function toResponse(analysis) {
  return {
    analysisId: analysis.analysisId,
    repository: analysis.repository,
    analyzed_at: analysis.createdAt,
    trigger: analysis.trigger || 'manual',
    pull_request: analysis.pullRequest || null,
    summary: summarize(analysis),
    issues: analysis.issues,
    static_analysis: analysis.staticAnalysis,
    dynamic_analysis: analysis.dynamicAnalysis,
    agents: analysis.agents,
  };
}

function toListItem(analysis) {
  const s = summarize(analysis);
  return {
    analysisId: analysis.analysisId,
    repository: analysis.repository,
    trigger: analysis.trigger || 'manual',
    pullRequestNumber: analysis.pullRequest?.number ?? null,
    pullRequestUrl: analysis.pullRequest?.url ?? null,
    decision: s.decision,
    risk_level: s.risk_level,
    issueCount: s.issueCount,
    fixableIssueCount: s.fixableIssueCount,
    dynamicStatus: s.dynamicStatus,
    created_at: analysis.createdAt,
  };
}

module.exports = { toResponse, toListItem, summarize };
