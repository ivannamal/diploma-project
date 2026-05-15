//the summary doesn't include raw file contents
//to never send big payload to LLM

const SYSTEM_PROMPT = `You are a security and deployment review assistant.

You receive a JSON summary of a repository analysis produced by a local
analyzer pipeline (static scanners + dynamic build/test/start checks in
Docker + agent verdicts). You must respond as if three logical agents
co-operated and produced a single verdict:

1. Security Analysis Agent — reads static findings (committed secrets,
   dangerous Dockerfile/CI patterns, suspicious package.json scripts).
2. Build and Test Analysis Agent — reads dynamic results: install / build
   / test / start outcomes inside Docker, including stage markers and
   timeouts.
3. Decision Agent — synthesises both reviews into a final verdict.

Rules for the Decision Agent (apply in order):
- Any critical security issue still open -> "block".
- Failed install / build / test inside Docker -> usually "block",
  occasionally "manual_review" if the evidence is ambiguous.
- Dynamic analysis timed out because of infrastructure / network / cache
  limits -> "manual_review", not "block".
- Only warnings / medium findings -> "manual_review".
- No serious issues and build/test passed -> "deploy".
- Evidence is incomplete or contradictory -> "manual_review".

You MUST return a single JSON object that matches this exact shape.
Do not include any prose, explanations, or markdown fences outside the
JSON. All string fields must be short and concrete.

{
  "agent_analysis": {
    "security_agent": {
      "status": "ok" | "warning" | "critical",
      "risk_level": "low" | "medium" | "high",
      "findings": [string, ...],
      "summary": string
    },
    "build_test_agent": {
      "status": "stable" | "warning" | "failed",
      "findings": [string, ...],
      "summary": string
    },
    "decision_agent": {
      "decision": "deploy" | "manual_review" | "block",
      "risk_level": "low" | "medium" | "high",
      "reason": string,
      "required_actions": [string, ...]
    }
  }
}`;

function userPrompt(summaryJson) {
  return `Analyze the repository summary below and return only the JSON object described in the system message.

Repository summary:
${summaryJson}`;
}

// summary to send to LLM:
//  - first 50 issues (sorted desc in order of importance)
//  - 1500 chars of stdout/stderr tails
//  - 30 recent npm fetches
function buildSummary(localResult) {
  const r = localResult || {};
  const dyn = r.dynamic_analysis || {};
  const stat = r.static_analysis || {};
  const localAgents = r.agents || {};
  const issues = Array.isArray(r.issues) ? r.issues.slice() : [];

  const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) =>
    (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));

  const compactIssues = issues.slice(0, 50).map((i) => ({
    type: i.type,
    source: i.source,
    severity: i.severity,
    file: i.file || null,
    line: i.line || null,
    message: trim(i.message, 240),
    status: i.status,
    has_safe_autofix: !!(i.fix && i.fix.available && i.fix.safe),
    details_excerpt: extractDetailsExcerpt(i.details),
  }));

  return {
    repository: r.repository || null,
    analyzed_at: r.analyzed_at || null,
    local_summary: r.summary || null,
    local_decision: localAgents.decision || null,
    local_security_agent: localAgents.security || null,
    local_build_test_agent: localAgents.buildTest || null,
    project_kind: dyn.kind || 'unknown',
    static_summary: {
      checkedFiles: stat.checkedFiles || 0,
      issueCount: stat.issueCount || 0,
      scanners: stat.scanners || [],
    },
    dynamic_summary: {
      status: dyn.status || 'unknown',
      kind: dyn.kind || null,
      lastStage: dyn.lastStage || null,
      completedStages: dyn.completedStages || [],
      installCommand: dyn.installCommand || null,
      installElapsedMs: dyn.installElapsedMs ?? null,
      totalElapsedMs: dyn.totalElapsedMs ?? null,
      healthPort: dyn.healthPort ?? null,
      timedOut: !!dyn.timedOut,
      exitCode: dyn.exitCode ?? null,
    },
    dynamic_stdout_tail: trim(dyn.stdoutTail, 1500),
    dynamic_stderr_tail: trim(dyn.stderrTail, 1500),
    issues: compactIssues,
    total_issue_count: issues.length,
    truncated_issues: issues.length > compactIssues.length,
  };
}

function extractDetailsExcerpt(details) {
  if (!details || typeof details !== 'object') return null;
  return {
    lastStage: details.lastStage || null,
    failedStage: details.failedStage || null,
    installCommand: details.installCommand || null,
    installElapsedMs: details.installElapsedMs ?? null,
    likelyInstallCause: details.likelyInstallCause || null,
    lastNpmActivity: trim(details.lastNpmActivity, 200),
    recentNpmFetches: Array.isArray(details.recentNpmFetches)
      ? details.recentNpmFetches.slice(-30)
      : [],
    recentNpmErrors: Array.isArray(details.recentNpmErrors)
      ? details.recentNpmErrors.slice(-5).map((s) => trim(s, 200))
      : [],
    timedOut: !!details.timedOut,
    exitCode: details.exitCode ?? null,
  };
}

function trim(s, max) {
  if (!s) return s || null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

module.exports = { SYSTEM_PROMPT, userPrompt, buildSummary };
