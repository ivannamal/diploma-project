// sends the local analysis result to the LLM
// and normalizes LLM's answer to the JSON object

const openaiClient = require('../services/openai.client');
const { SYSTEM_PROMPT, userPrompt, buildSummary } = require('./openaiPrompt');
const logger = require('../utils/logger');

const ALLOWED_SEC_STATUS = new Set(['ok', 'warning', 'critical']);
const ALLOWED_BUILD_STATUS = new Set(['stable', 'warning', 'failed']);
const ALLOWED_DECISION = new Set(['deploy', 'manual_review', 'block']);
const ALLOWED_RISK = new Set(['low', 'medium', 'high']);

const DEFAULT_MODEL = 'gpt-4.1-mini';

async function analyze(localResult) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const e = new Error('OpenAI analysis is not configured. Please set OPENAI_API_KEY.');
    e.code = 'openai_not_configured';
    e.status = 400;
    throw e;
  }
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const summary = buildSummary(localResult);

  const completion = await openaiClient.chatCompletion({
    apiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(JSON.stringify(summary, null, 2)) },
    ],
    temperature: 0.2,
  });

  const content = completion?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI returned an empty response.');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAI returned invalid JSON: ${err.message}`);
  }

  const agentAnalysis = normalize(parsed.agent_analysis);
  logger.info('OpenAI agent analysis complete', {
    model,
    decision: agentAnalysis.decision_agent.decision,
  });

  return {
    model,
    agent_analysis: agentAnalysis,
  };
}

function normalize(aa) {
  const safe = aa && typeof aa === 'object' ? aa : {};
  return {
    security_agent: normSecurity(safe.security_agent),
    build_test_agent: normBuild(safe.build_test_agent),
    decision_agent: normDecision(safe.decision_agent),
  };
}

function normSecurity(s) {
  const safe = s && typeof s === 'object' ? s : {};
  return {
    status: ALLOWED_SEC_STATUS.has(safe.status) ? safe.status : 'warning',
    risk_level: ALLOWED_RISK.has(safe.risk_level) ? safe.risk_level : 'medium',
    findings: stringArray(safe.findings, 20),
    summary: typeof safe.summary === 'string' ? safe.summary : '',
  };
}

function normBuild(b) {
  const safe = b && typeof b === 'object' ? b : {};
  return {
    status: ALLOWED_BUILD_STATUS.has(safe.status) ? safe.status : 'warning',
    findings: stringArray(safe.findings, 20),
    summary: typeof safe.summary === 'string' ? safe.summary : '',
  };
}

function normDecision(d) {
  const safe = d && typeof d === 'object' ? d : {};
  return {
    decision: ALLOWED_DECISION.has(safe.decision) ? safe.decision : 'manual_review',
    risk_level: ALLOWED_RISK.has(safe.risk_level) ? safe.risk_level : 'medium',
    reason: typeof safe.reason === 'string' ? safe.reason : '',
    required_actions: stringArray(safe.required_actions, 20),
  };
}

function stringArray(v, max) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x === 'string' && x.trim() !== '') out.push(x.length > 400 ? x.slice(0, 400) + '…' : x);
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { analyze };
