// ai-assisted verified autofix
//
// pipeline for one call:
//   1. look up analysis + issue in stateService
//   2. build a compact context for openAI
//   3. ask OpenAI for a "fix plan" (strict json)
//   4. validate the plan against the safety allowlist
//   5. copy the analysis repo into a separate fix workspace
//   6. apply the plan inside the workspace
//   7. re-run static analysis (and dynamic if needed) on the workspace
//   8. compare against the original analysis
//   9. if verification passes, store a verified fix; otherwise store an
//      attempted-but-failed fix. workspace is always cleaned up


const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const stateService = require('./state.service');
const openaiClient = require('./openai.client');
const { SYSTEM_PROMPT, userPrompt, buildFixContext } = require('../agents/openaiFixPrompt');
const staticAnalyzer = require('../analyzers/static/staticAnalyzer');
const dynamicAnalyzer = require('../analyzers/dynamic/dynamicAnalyzer');
const { unifiedDiff } = require('../utils/diff');
const { analysisDir, assertInsideRepo } = require('../utils/paths');
const logger = require('../utils/logger');

const MAX_CHANGED_FILES = 5;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024;
const MAX_AI_FIX_ATTEMPTS = 3;

// test-file detection heuristics
const TEST_PATH_RE = /(^|\/)(?:tests?|spec|__tests__)\//i;
const TEST_FILE_RE = /\.(?:test|spec)\.(?:c|m)?[jt]sx?$/i;

// patterns that bypass tests if added by the patch
const SKIP_BYPASS = [
  { re: /\b(?:test|it|describe)\.skip\s*\(/, signal: 'added_test_skip' },
  { re: /\b(?:test|it|describe)\.only\s*\(/, signal: 'added_test_only' },
  { re: /\bxit\s*\(/, signal: 'added_xit' },
  { re: /\bxtest\s*\(/, signal: 'added_xtest' },
  { re: /\bxdescribe\s*\(/, signal: 'added_xdescribe' },
  { re: /\bprocess\.exit\s*\(\s*0\s*\)/, signal: 'added_process_exit_zero' },
];

const ASSERT_RE = /\b(?:expect|assert|should)\s*[(.]/g;
const IMPORT_RE = /^(?:\s*import\b|.*\brequire\s*\()/gm;
const TRIVIAL_SCRIPT_RE = /^(?:\s*(?:true|:|exit\s+0|echo\b[^&|;]*|node\s+-e\s+["']?\s*["']?))\s*$/i;

const ALLOWED_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.md', '.txt', '.html', '.htm', '.css', '.scss',
  '.py', '.rb', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.rs',
  '.xml', '.svg', '.sh', '.bash', '.ps1', '.bat', '.env',
]);

const ALLOWED_NAMES = new Set([
  'Dockerfile', 'Containerfile', 'Makefile',
  '.gitignore', '.dockerignore', '.editorconfig', '.npmrc', '.env.example',
]);


async function generateFix(analysisId, issueId) {
  const analysis = stateService.get(analysisId);
  if (!analysis) {
    const e = new Error('Analysis not found or expired.');
    e.code = 'not_found'; e.status = 404; throw e;
  }
  const issue = (analysis.issues || []).find((i) => i.id === issueId);
  if (!issue) {
    const e = new Error('Issue not found in the given analysis.');
    e.code = 'not_found'; e.status = 404; throw e;
  }

  if (issue.fix && issue.fix.available && issue.fix.safe) {
    const e = new Error('A predefined safe autofix already exists for this issue.');
    e.code = 'predefined_fix_exists'; e.status = 409; throw e;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const e = new Error('AI fix is not configured. Please set OPENAI_API_KEY.');
    e.code = 'openai_not_configured'; e.status = 400; throw e;
  }

  const sessionId = 'fix_' + crypto.randomBytes(8).toString('hex');
  logger.info('AI fix generation started', {
    analysisId, issueId, sessionId,
    type: issue.type, maxAttempts: MAX_AI_FIX_ATTEMPTS,
  });

  const attempts = [];
  let feedback = null;

  for (let attempt = 1; attempt <= MAX_AI_FIX_ATTEMPTS; attempt++) {
    logger.info('ai_fix_attempt_started', { sessionId, attempt });

    const outcome = await runSingleAttempt({
      attempt, sessionId, analysis, issue, feedback,
    });
    attempts.push(outcome.record);

    if (outcome.record.status === 'verified') {
      logger.info('ai_fix_attempt_verified', {
        sessionId, attempt, fixId: outcome.record.fixId,
      });
      return publicFixView(outcome.verifiedFix, {
        attempts: attemptSummaries(attempts),
      });
    }

    logger.warn('ai_fix_attempt_rejected', {
      sessionId,
      attempt,
      reason: outcome.record.reason,
      signals: outcome.record.signals,
    });

    if (attempt < MAX_AI_FIX_ATTEMPTS) {
      feedback = composeFeedback(outcome.record);
      logger.info('ai_fix_attempt_regenerating', {
        sessionId, nextAttempt: attempt + 1, lastReason: outcome.record.reason,
      });
    }
  }

  logger.warn('ai_fix_generation_failed_all_attempts', {
    sessionId, attempts: attempts.length,
  });
  return publicFailedResponse({
    sessionId,
    issueId,
    analysisId,
    attempts,
  });
}

async function runSingleAttempt({ attempt, sessionId, analysis, issue, feedback }) {
  const context = buildFixContext(analysis, issue);

  let plan;
  try {
    plan = await callOpenAIFixAgent(context, feedback);
  } catch (err) {
    return {
      record: {
        attempt, status: 'rejected',
        reason: 'openai_call_failed',
        signals: [err.message],
      },
    };
  }
  logger.info('OpenAI fix response received', {
    sessionId, attempt,
    can_fix: plan.can_fix, confidence: plan.confidence,
    changeCount: Array.isArray(plan.changes) ? plan.changes.length : 0,
  });

  if (!plan.can_fix) {
    return {
      record: {
        attempt, status: 'rejected',
        reason: 'openai_declined',
        signals: [],
        explanation: plan.explanation || '',
      },
    };
  }

  let normalised;
  try {
    normalised = validateFixPlan(plan);
  } catch (err) {
    logger.warn('AI patch validation failed', { sessionId, attempt, message: err.message });
    return {
      record: {
        attempt, status: 'rejected',
        reason: 'validation_failed',
        signals: [err.message],
      },
    };
  }

  const weakening = detectTestWeakening(normalised.changes, issue, analysis.repoPath);
  if (weakening.weakens) {
    return {
      record: {
        attempt, status: 'rejected',
        reason: 'patch_weakens_tests',
        signals: weakening.signals,
      },
    };
  }

  const fixId = 'fix_' + crypto.randomBytes(8).toString('hex');
  let workspace;
  try {
    workspace = await createFixWorkspace(analysis.analysisId, fixId, analysis.repoPath);
    await applyFixPlan(workspace, normalised.changes);
    logger.info('AI patch applied to fix workspace', { sessionId, attempt, fixId });
  } catch (err) {
    if (workspace) await safeRm(workspace);
    return {
      record: {
        attempt, status: 'rejected',
        reason: 'apply_failed',
        signals: [err.message],
      },
    };
  }

  let verification;
  let diffBundle;
  try {
    logger.info('Verification started', { sessionId, attempt, fixId });
    diffBundle = await buildDiffBundle(analysis.repoPath, workspace, normalised.changes);
    verification = await verifyFix({
      originalAnalysis: analysis,
      issue,
      workspaceRepoPath: workspace,
      changes: normalised.changes,
    });
  } catch (err) {
    verification = { status: 'failed', reason: `Verification crashed: ${err.message}` };
  } finally {
    await safeRm(workspace);
  }

  if (verification.status !== 'passed') {
    logger.warn('Verification failed', { sessionId, attempt, reason: verification.reason });
    return {
      record: {
        attempt, status: 'verification_failed',
        reason: verification.reason || 'verification_failed',
        signals: [],
      },
    };
  }

  logger.info('Verification passed', { sessionId, attempt, fixId });
  const verifiedFix = {
    fixId,
    issueId: issue.id,
    analysisId: analysis.analysisId,
    type: 'ai_verified_fix',
    available: true,
    verified: true,
    confidence: plan.confidence || 'medium',
    description: plan.explanation || 'AI-proposed fix verified against rerun of the analysis.',
    risk_notes: Array.isArray(plan.risk_notes) ? plan.risk_notes.slice(0, 10) : [],
    verification_plan: Array.isArray(plan.verification_plan) ? plan.verification_plan.slice(0, 10) : [],
    changedFiles: diffBundle.changedFiles,
    diff: diffBundle.diff,
    changes: normalised.changes.map((c) => ({
      file: c.file, action: 'replace_file', content: c.content,
    })),
    verification,
    created_at: new Date().toISOString(),
    status: 'verified',
  };
  stateService.putAiFix(verifiedFix);

  return {
    record: { attempt, status: 'verified', fixId, signals: [] },
    verifiedFix,
  };
}


function isTestFile(relPath) {
  if (!relPath) return false;
  return TEST_FILE_RE.test(relPath) || TEST_PATH_RE.test('/' + relPath);
}

function countMatches(text, re) {
  if (!text) return 0;
  // recreate the regex from source to keep `g`-flag state clean
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return (text.match(new RegExp(re.source, flags)) || []).length;
}

function readOriginalFile(repoPath, relPath) {
  try { return fs.readFileSync(path.join(repoPath, relPath), 'utf8'); }
  catch { return null; }
}

function detectTestWeakening(changes, issue, originalRepoPath) {
  const signals = new Set();
  const allTest = changes.length > 0 && changes.every((c) => isTestFile(c.file));

  if (issue.type === 'dynamic_test_failed' && allTest) {
    signals.add('only_test_files_changed_for_test_failure');
  }

  for (const ch of changes) {
    const oldContent = readOriginalFile(originalRepoPath, ch.file) || '';
    const newContent = ch.content;

    // skip patterns added by the patch
    for (const check of SKIP_BYPASS) {
      if (check.re.test(newContent) && !check.re.test(oldContent)) {
        signals.add(check.signal);
      }
    }

    if (isTestFile(ch.file)) {
      const oldAssert = countMatches(oldContent, ASSERT_RE);
      const newAssert = countMatches(newContent, ASSERT_RE);
      if (newAssert < oldAssert) signals.add('reduced_assertions');

      const oldImports = countMatches(oldContent, IMPORT_RE);
      const newImports = countMatches(newContent, IMPORT_RE);
      if (newImports < oldImports) signals.add('removed_test_imports');
    }

    if (ch.file === 'package.json') {
      try {
        const oldPkg = JSON.parse(oldContent || '{}');
        const newPkg = JSON.parse(newContent);
        const oldScripts = (oldPkg && oldPkg.scripts) || {};
        const newScripts = (newPkg && newPkg.scripts) || {};
        if (oldScripts.test && newScripts.test !== oldScripts.test) {
          if (!newScripts.test || TRIVIAL_SCRIPT_RE.test(String(newScripts.test).trim())) {
            signals.add('disabled_test_script');
          }
        }
        if (oldScripts.build && newScripts.build !== oldScripts.build) {
          if (!newScripts.build || TRIVIAL_SCRIPT_RE.test(String(newScripts.build).trim())) {
            signals.add('disabled_build_script');
          }
        }
      } catch { }
    }
  }

  return { weakens: signals.size > 0, signals: [...signals] };
}

//feedback for next prompt
function composeFeedback(record) {
  switch (record.reason) {
    case 'patch_weakens_tests':
      return [
        'Your previous patch was rejected because it weakened tests instead of fixing the implementation.',
        `Detected signals: ${(record.signals || []).join(', ') || 'unknown'}.`,
        'Do not modify tests unless the issue is explicitly caused by an incorrect test.',
        'Preserve existing assertions and imports. Do not add .skip / .only / process.exit(0) or other bypasses.',
        'Do not change "test" or "build" scripts in package.json to trivial commands.',
        'For dynamic_test_failed issues, fix the implementation source file, not the test.',
        'If you cannot fix without editing tests, return can_fix: false.',
      ].join(' ');

    case 'verification_failed':
      return [
        'Your previous patch was applied and validated structurally, but verification failed:',
        record.reason || '',
        record.signals && record.signals.length ? `(${record.signals.join('; ')})` : '',
        'The original issue may still be reported, new high/critical issues may have appeared,',
        'or the dynamic build/test pipeline regressed. Propose a different, more conservative fix.',
      ].join(' ');

    case 'validation_failed':
      return [
        'Your previous response failed structural validation:',
        (record.signals && record.signals[0]) || 'unknown reason.',
        'Return strict JSON with replace_file actions only, stay within the size and file-allowlist limits,',
        'and do not return unified patches.',
      ].join(' ');

    case 'apply_failed':
      return [
        'Your previous patch could not be applied to a workspace:',
        (record.signals && record.signals[0]) || 'unknown reason.',
        'Make sure every "file" path is relative and inside the repository, and that "content" is a plain text file.',
      ].join(' ');

    case 'openai_declined':
      return [
        'Your previous response said can_fix=false.',
        record.explanation || '',
        'If a safe fix is genuinely possible, try again with the smallest possible change.',
        'Otherwise keep returning can_fix=false and explain what context is missing.',
      ].join(' ');

    case 'openai_call_failed':
      return 'The previous OpenAI request failed at the transport level. Re-try with the same constraints.';

    default:
      return 'Your previous attempt did not produce an applyable fix. Try again with a different, smaller change.';
  }
}


function attemptSummaries(attempts) {
  // only metadata, not diff or generated content
  return attempts.map((a) => ({
    attempt: a.attempt,
    status: a.status,
    reason: a.reason || null,
    signals: a.signals || [],
    fixId: a.fixId || null,
  }));
}

function publicFailedResponse({ sessionId, issueId, analysisId, attempts }) {
  const hasWeakening = attempts.some((a) => a.reason === 'patch_weakens_tests');
  const hasOriginalStill = attempts.some(
    (a) => a.status === 'verification_failed' &&
      /original issue/i.test(String(a.reason || ''))
  );

  let reason;
  if (hasWeakening) reason = 'Generated fixes attempted to weaken tests.';
  else if (hasOriginalStill) reason = 'The original issue remained after generated fixes.';
  else reason = 'All generated fixes failed verification.';

  return {
    sessionId,
    issueId,
    analysisId,
    type: 'ai_verified_fix',
    available: false,
    verified: false,
    status: 'failed_all_attempts',
    message: 'AI could not generate a verified safe fix for this issue.',
    reason,
    attempts: attemptSummaries(attempts),
  };
}

async function applyVerifiedFix(fixId) {
  const fix = stateService.getAiFix(fixId);
  if (!fix) {
    const e = new Error('AI fix not found or expired.');
    e.code = 'not_found'; e.status = 404; throw e;
  }
  if (!fix.verified || !fix.available) {
    const e = new Error('This AI fix is not verified and cannot be applied.');
    e.code = 'fix_not_verified'; e.status = 400; throw e;
  }
  if (fix.status === 'applied') {
    return publicFixView(fix);
  }

  const analysis = stateService.get(fix.analysisId);
  if (!analysis) {
    const e = new Error('Underlying analysis has expired.');
    e.code = 'not_found'; e.status = 404; throw e;
  }
  const issue = (analysis.issues || []).find((i) => i.id === fix.issueId);
  if (!issue) {
    const e = new Error('Underlying issue is gone.');
    e.code = 'not_found'; e.status = 404; throw e;
  }

  const repoPath = analysis.repoPath;
  const before = new Map();
  for (const ch of fix.changes) {
    const target = path.join(repoPath, ch.file);
    assertInsideRepo(repoPath, target);
    let prev = '';
    try { prev = fs.readFileSync(target, 'utf8'); } catch { /* file was missing */ }
    before.set(ch.file, prev);
  }

  for (const ch of fix.changes) {
    const target = path.join(repoPath, ch.file);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, ch.content, 'utf8');
  }

  const diffs = [];
  for (const ch of fix.changes) {
    diffs.push(unifiedDiff(before.get(ch.file) || '', ch.content, ch.file));
  }
  const finalDiff = diffs.join('\n\n');

  issue.status = 'fixed';
  if (issue.fix) {
    issue.fix.applied_at = new Date().toISOString();
    issue.fix.applied_via = 'ai_verified_fix';
  } else {
    issue.fix = { available: false, safe: true, applied_at: new Date().toISOString(), applied_via: 'ai_verified_fix' };
  }
  fix.status = 'applied';
  fix.applied_at = new Date().toISOString();
  fix.diff = finalDiff;
  logger.info('Verified fix applied', { fixId, analysisId: fix.analysisId, issueId: fix.issueId });

  return {
    fixId,
    issueId: fix.issueId,
    analysisId: fix.analysisId,
    status: 'applied',
    changedFiles: fix.changedFiles,
    diff: finalDiff,
    message: 'AI-proposed fix verified and applied to the temporary repository copy.',
  };
}

function listFixesForIssue(analysisId, issueId) {
  return stateService.listAiFixesForIssue(analysisId, issueId).map(publicFixView);
}

async function callOpenAIFixAgent(context, feedback) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

  const completion = await openaiClient.chatCompletion({
    apiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(JSON.stringify(context, null, 2), feedback) },
    ],
    temperature: 0.1,
    timeoutMs: 90_000,
  });

  const content = completion?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI returned an empty fix response.');
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAI returned invalid JSON: ${err.message}`);
  }
  return {
    can_fix: parsed.can_fix === true,
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low',
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    changes: Array.isArray(parsed.changes) ? parsed.changes : [],
    verification_plan: Array.isArray(parsed.verification_plan) ? parsed.verification_plan : [],
    risk_notes: Array.isArray(parsed.risk_notes) ? parsed.risk_notes : [],
  };
}

function validateFixPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('Plan is not an object.');
  if (!Array.isArray(plan.changes)) throw new Error('Plan.changes must be an array.');
  if (plan.changes.length === 0) throw new Error('Plan.changes is empty.');
  if (plan.changes.length > MAX_CHANGED_FILES) {
    throw new Error(`Plan touches ${plan.changes.length} files (max ${MAX_CHANGED_FILES}).`);
  }

  let total = 0;
  const out = [];
  for (const raw of plan.changes) {
    if (!raw || typeof raw !== 'object') throw new Error('Change entry is not an object.');
    if (raw.action !== 'replace_file') {
      throw new Error(`Unsupported action "${raw.action}" — only "replace_file" is accepted.`);
    }
    if (typeof raw.file !== 'string' || !raw.file) {
      throw new Error('Change entry is missing a file path.');
    }
    if (typeof raw.content !== 'string') {
      throw new Error(`Change entry for "${raw.file}" is missing string content.`);
    }
    const rel = normaliseRelPath(raw.file);
    if (!rel) throw new Error(`Refusing path "${raw.file}".`);
    if (!isAllowedFile(rel)) {
      throw new Error(`File "${rel}" is not in the allowed text-file allowlist.`);
    }
    const size = Buffer.byteLength(raw.content, 'utf8');
    if (size > MAX_FILE_BYTES) {
      throw new Error(`File "${rel}" content is ${size} bytes (max ${MAX_FILE_BYTES}).`);
    }
    if (raw.content.indexOf(' ') !== -1) {
      throw new Error(`File "${rel}" content contains NUL bytes.`);
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`Total content is ${total} bytes (max ${MAX_TOTAL_BYTES}).`);
    }
    out.push({ file: rel, action: 'replace_file', content: raw.content });
  }
  return { changes: out };
}

function normaliseRelPath(p) {
  if (typeof p !== 'string') return null;
  let n = p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!n) return null;
  if (path.isAbsolute(n)) return null;
  const segs = n.split('/');
  if (segs.some((s) => s === '..' || s === '' || s === '.')) return null;
  if (segs[0] === '.git') return null;
  return n;
}

function isAllowedFile(relPath) {
  const base = path.basename(relPath);
  if (ALLOWED_NAMES.has(base)) return true;
  if (/^Dockerfile(\..+)?$/i.test(base)) return true;
  if (/^\.env(\..+)?$/i.test(base)) return true;
  const ext = path.extname(base).toLowerCase();
  return ALLOWED_EXT.has(ext);
}

async function createFixWorkspace(analysisId, fixId, srcRepoPath) {
  const workspace = path.join(analysisDir(analysisId), 'fixes', fixId, 'repo');
  await fsp.mkdir(path.dirname(workspace), { recursive: true });
  await fsp.cp(srcRepoPath, workspace, {
    recursive: true,
    filter: (src) => {
      const segs = src.split(/[\\/]/);
      return !segs.includes('.git');
    },
  });
  return workspace;
}

async function applyFixPlan(workspaceRepoPath, changes) {
  for (const ch of changes) {
    const target = path.join(workspaceRepoPath, ch.file);
    assertInsideRepo(workspaceRepoPath, target);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, ch.content, 'utf8');
  }
}

async function buildDiffBundle(originalRepoPath, workspaceRepoPath, changes) {
  const diffs = [];
  const changedFiles = [];
  for (const ch of changes) {
    let before = '';
    try { before = await fsp.readFile(path.join(originalRepoPath, ch.file), 'utf8'); } catch { /* new file */ }
    const after = ch.content;
    if (before === after) continue;
    diffs.push(unifiedDiff(before, after, ch.file));
    changedFiles.push(ch.file);
  }
  return { diff: diffs.join('\n\n'), changedFiles };
}


async function verifyFix({ originalAnalysis, issue, workspaceRepoPath, changes }) {
  const staticResult = await staticAnalyzer.analyze(workspaceRepoPath);

  const shouldRunDynamic =
    issue.source === 'dynamic' || planTouchesBuildFiles(changes);

  let dynamicResult = { issues: [], summary: { status: 'skipped', kind: null } };
  if (shouldRunDynamic) {
    dynamicResult = await dynamicAnalyzer.analyze(workspaceRepoPath, {
      analysisId: 'aifix-verify-' + Date.now(),
    });
  }

  const stillThere = (staticResult.issues.concat(dynamicResult.issues))
    .some((i) => matchesOriginal(i, issue));
  if (stillThere) {
    return { status: 'failed', reason: 'The original issue is still reported after the fix.' };
  }

  const origSerious = serialiseIssues(originalAnalysis.issues || [], ['high', 'critical']);
  const newSerious = (staticResult.issues.concat(dynamicResult.issues))
    .filter((i) => i.severity === 'high' || i.severity === 'critical')
    .filter((i) => !origSerious.has(serialiseIssue(i)));
  if (newSerious.length > 0) {
    return {
      status: 'failed',
      reason: `${newSerious.length} new high/critical issue${newSerious.length === 1 ? '' : 's'} introduced (e.g. ${newSerious[0].type}).`,
    };
  }

  const originalDynamicStatus = originalAnalysis.dynamicAnalysis?.status || 'skipped';
  if (shouldRunDynamic) {
    if (dynamicResult.summary.status === 'failed' && originalDynamicStatus !== 'failed') {
      return { status: 'failed', reason: 'Dynamic build/test/start pipeline became failed after the fix.' };
    }
  }

  return {
    status: 'passed',
    originalIssueResolved: true,
    newHighIssues: 0,
    dynamicStatus: dynamicResult.summary.status,
    rerunCounts: {
      static: staticResult.issues.length,
      dynamic: dynamicResult.issues.length,
    },
  };
}

function planTouchesBuildFiles(changes) {
  return changes.some((c) => {
    const f = c.file;
    return f === 'package.json' ||
      f === 'package-lock.json' ||
      f === 'requirements.txt' ||
      f === 'pyproject.toml' ||
      f === 'Pipfile' ||
      f === 'Dockerfile' ||
      f.startsWith('.github/workflows/');
  });
}

function matchesOriginal(candidate, original) {
  return candidate.type === original.type &&
    (candidate.file || null) === (original.file || null) &&
    (candidate.line || null) === (original.line || null);
}

function serialiseIssue(i) {
  return `${i.type}|${i.file || ''}|${i.line || ''}`;
}

function serialiseIssues(issues, severities) {
  const set = new Set();
  for (const i of issues) {
    if (severities.includes(i.severity)) set.add(serialiseIssue(i));
  }
  return set;
}

function publicFixView(fix, extras = {}) {
  return {
    fixId: fix.fixId,
    issueId: fix.issueId,
    analysisId: fix.analysisId,
    type: fix.type,
    available: fix.available,
    verified: fix.verified,
    confidence: fix.confidence,
    description: fix.description,
    risk_notes: fix.risk_notes,
    verification_plan: fix.verification_plan,
    changedFiles: fix.changedFiles,
    diff: fix.diff,
    verification: fix.verification,
    created_at: fix.created_at,
    status: fix.status,
    applied_at: fix.applied_at || null,
    attempts: extras.attempts || null,
  };
}

async function safeRm(dir) {
  if (!dir) return;
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (err) { logger.warn('Could not clean fix workspace', { dir, message: err.message }); }
}

module.exports = {
  generateFix,
  applyVerifiedFix,
  listFixesForIssue,
  buildFixContext,
  callOpenAIFixAgent,
  validateFixPlan,
  createFixWorkspace,
  applyFixPlan,
  verifyFix,
};
