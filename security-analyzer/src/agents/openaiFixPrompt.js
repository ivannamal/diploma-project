const fs = require('fs');
const path = require('path');

const MAX_FILES = 10;
const MAX_FILE_BYTES = 30 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024;

const TEST_PATH_RE = /(^|\/)(?:tests?|spec|__tests__)\//i;
const TEST_FILE_RE = /\.(?:test|spec)\.(?:c|m)?[jt]sx?$/i;

const SYSTEM_PROMPT = `You are an automated code-fix agent inside a security analyzer.

You are given ONE issue produced by static or dynamic analysis together
with the project context the analyzer collected for you. The context
object has this shape:

{
  "issue": { ... },
  "analysisSummary": { ... },
  "dynamicDetails": { ... },         // present for dynamic-source issues
  "relevantFiles": [
    {
      "path": "relative/path",
      "role": "failing_test" | "source_under_test"
            | "issue_target"   | "project_metadata"
            | "ci_workflow"    | "dockerfile",
      "content": "..."
    },
    ...
  ],
  "source_under_test_resolved": true | false
}

You have been given the failing test file and the source files imported
by that test. For dynamic test failures, fix the source_under_test
files first. Do not rewrite the failing test unless the issue is
explicitly caused by an incorrect test.

If source_under_test_resolved is false (the source files under test
could not be located) and the issue is a dynamic test failure, return:
  { "can_fix": false, "confidence": "low",
    "explanation": "Source file under test could not be resolved from the provided context.",
    "changes": [], "verification_plan": [], "risk_notes": [] }

Hard rules — your response will be rejected if any of these are
violated:
- Return STRICT JSON only. No prose. No markdown fences. No commentary.
- Prefer minimal changes. Touch as few files as possible.
- Use the "replace_file" action with the FULL new content of each
  changed file. Do not return unified patches.
- Do not invent files. Do not introduce new dependencies unless that is
  the only way to fix the issue.
- You are NOT allowed to make tests easier to pass.
- You are NOT allowed to remove existing assertions
  (expect / assert / should / chai.expect).
- You are NOT allowed to replace tested imports with local fake
  implementations inside test files (e.g. defining a stub function in
  the test file that shadows the real module under test).
- You are NOT allowed to skip tests with .skip, .only, xit, xtest,
  xdescribe, early return, or process.exit(0).
- You are NOT allowed to disable npm scripts by rewriting "test" or
  "build" to "true", "exit 0", "echo ok" or any equivalent no-op.
- For dynamic_test_failed issues, prefer fixing the implementation
  source file, NOT the test file.
- Do not weaken security checks, lint rules, type checks, or assertions.
- Do not hide, encrypt, or rename secrets to evade the secret scanner.
  If a secret was committed, propose moving the value to an env variable
  and updating .gitignore — do not just rewrite the literal.
- If you are not confident a fix is safe and correct, return
  can_fix: false and explain why.

Response schema (return EXACTLY this shape, all fields required):

{
  "can_fix": true | false,
  "confidence": "low" | "medium" | "high",
  "explanation": string,
  "changes": [
    {
      "file": "relative/path/inside/repo",
      "action": "replace_file",
      "content": "full new file contents"
    }
  ],
  "verification_plan": [string, ...],
  "risk_notes": [string, ...]
}

If can_fix is false, the arrays must be empty.`;

function userPrompt(contextJson, feedback) {
  let s = `Propose a fix for the issue described below. Return only the JSON object specified in the system message.

Context:
${contextJson}`;
  if (feedback && typeof feedback === 'string' && feedback.trim()) {
    s += `

Feedback from your previous attempt (must be addressed):
${feedback.trim()}`;
  }
  return s;
}


function safeReadText(filePath, limit = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, limit));
      fs.readSync(fd, buf, 0, buf.length, 0);
      // reject binary-looking files (NUL bytes)
      if (buf.indexOf(0) !== -1) return null;
      const text = buf.toString('utf8');
      const truncated = stat.size > limit;
      return { content: text, size: stat.size, truncated };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}


function parseFailingTestFromOutput(stdoutTail, stderrTail) {
  const text = `${stdoutTail || ''}\n${stderrTail || ''}`;
  const testFiles = new Set();
  const stackFiles = new Set();
  const assertionMessages = [];
  const functionNames = new Set();

  // jest: "FAIL <path>"
  for (const m of text.matchAll(/(?:^|\n)\s*(?:FAIL|✕|✗)\s+([^\s\n]+\.(?:[mc]?[jt]sx?|py|rb|go))/g)) {
    testFiles.add(m[1]);
  }
  // mocha / node:test: "  at <ctx> (/work/path/file.js:12:3)"
  // also bare "at <path>:line:col"
  for (const m of text.matchAll(/\bat\s+(?:[^(\n]+\()?([^\s)(:]+\.(?:[mc]?[jt]sx?|py|rb|go))(?::\d+:\d+)?\)?/g)) {
    stackFiles.add(m[1]);
  }
  // jest "Expected: ..."/"Received: ..." messages
  for (const m of text.matchAll(/(?:Expected|expected|Received|received)[^\n]{0,200}/g)) {
    assertionMessages.push(m[0].trim());
    if (assertionMessages.length >= 8) break;
  }
  for (const m of text.matchAll(/\b(?:TypeError|ReferenceError|AssertionError)[:\s][^\n]*?\b([A-Za-z_][\w]*)\b/g)) {
    functionNames.add(m[1]);
    if (functionNames.size >= 12) break;
  }

  let testFile = null;
  for (const f of testFiles) {
    if (TEST_FILE_RE.test(f) || TEST_PATH_RE.test('/' + f)) { testFile = f; break; }
  }
  if (!testFile) {
    for (const f of stackFiles) {
      if (TEST_FILE_RE.test(f) || TEST_PATH_RE.test('/' + f)) { testFile = f; break; }
    }
  }
  if (!testFile && testFiles.size) testFile = testFiles.values().next().value;

  return {
    testFile,
    stackFiles: [...stackFiles],
    assertionMessages: assertionMessages.slice(0, 5),
    functionNames: [...functionNames].slice(0, 10),
  };
}

function normalizeRepoRel(p, repoPath) {
  if (!p || typeof p !== 'string') return null;
  let n = p.replace(/\\/g, '/').trim();
  n = n.replace(/^\/work\//, '');
  n = n.replace(/^\.\//, '');
  if (n.startsWith('/')) return null;          // absolute outside /work
  if (n.split('/').some((s) => s === '..')) return null;
  try {
    const stat = fs.statSync(path.join(repoPath, n));
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return n;
}


function parseLocalImports(content) {
  if (!content) return [];
  const out = new Set();
  for (const m of content.matchAll(/\brequire\s*\(\s*["']([.][^"']+)["']\s*\)/g)) {
    out.add(m[1]);
  }
  for (const m of content.matchAll(/\bimport\s+(?:[^"';]+\s+from\s+)?["']([.][^"']+)["']/g)) {
    out.add(m[1]);
  }
  for (const m of content.matchAll(/\bimport\s*\(\s*["']([.][^"']+)["']\s*\)/g)) {
    out.add(m[1]);
  }
  return [...out];
}

function resolveImport(fromRelFile, importPath, repoPath) {
  const fromDir = path.dirname(path.resolve(repoPath, fromRelFile));
  const base = path.resolve(fromDir, importPath);

  const tryFile = (p) => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return null;
      const rel = path.relative(repoPath, p).replace(/\\/g, '/');
      if (rel.startsWith('..')) return null; // outside repo
      return rel;
    } catch { return null; }
  };

  // already has an extension?
  if (path.extname(base)) {
    return tryFile(base);
  }
  const exts = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
  for (const ext of exts) {
    const r = tryFile(base + ext);
    if (r) return r;
  }
  for (const ext of exts) {
    const r = tryFile(path.join(base, 'index' + ext));
    if (r) return r;
  }
  return null;
}


// returns { payload, meta }
//   payload = sent to OpenAI as JSON.
//   meta    - { failingTestPath, sourceUnderTestPaths } for the
//             service layer (logging + guardrails)
function buildFixContext(analysis, issue) {
  const repoPath = analysis.repoPath;
  const payload = {
    repository: analysis.repository,
    project_kind: analysis.dynamicAnalysis?.kind || 'unknown',
    issue: {
      id: issue.id,
      type: issue.type,
      source: issue.source,
      severity: issue.severity,
      file: issue.file || null,
      line: issue.line || null,
      message: issue.message,
      recommendation: issue.recommendation,
    },
    analysisSummary: {
      decision: analysis.agents?.decision?.decision || null,
      risk_level: analysis.agents?.decision?.risk_level || null,
      static_issue_count: analysis.staticAnalysis?.issueCount || 0,
      dynamic_status: analysis.dynamicAnalysis?.status || null,
    },
    dynamicDetails: stripDetails(issue.details),
    failureHints: null,
    relevantFiles: [],
    source_under_test_resolved: false,
  };

  const meta = {
    failingTestPath: null,
    sourceUnderTestPaths: [],
  };

  let total = 0;
  const seen = new Set();
  const addFile = (relPath, role) => {
    if (!relPath || seen.has(relPath) || payload.relevantFiles.length >= MAX_FILES) return false;
    const piece = safeReadText(path.join(repoPath, relPath), MAX_FILE_BYTES);
    if (!piece) return false;
    const size = Buffer.byteLength(piece.content, 'utf8');
    if (total + size > MAX_TOTAL_BYTES) return false;
    seen.add(relPath);
    payload.relevantFiles.push({
      path: relPath,
      role,
      content: piece.content,
      truncated: piece.truncated,
      fullSize: piece.size,
    });
    total += size;
    return true;
  };

  if (issue.file) {
    const isFailingTest = issue.type === 'dynamic_test_failed' && isTestFile(issue.file);
    addFile(issue.file, isFailingTest ? 'failing_test' : 'issue_target');
    if (isFailingTest) meta.failingTestPath = issue.file;
  }


  if (issue.type === 'dynamic_test_failed') {
    const details = issue.details || {};
    const parsed = parseFailingTestFromOutput(details.stdoutTail, details.stderrTail);
    payload.failureHints = {
      candidateTestFile: parsed.testFile || null,
      stackFiles: parsed.stackFiles.slice(0, 5),
      assertionMessages: parsed.assertionMessages,
      functionNames: parsed.functionNames,
    };

    const fromLog = normalizeRepoRel(parsed.testFile, repoPath);
    const testRel = meta.failingTestPath || fromLog;
    if (testRel) {
      meta.failingTestPath = testRel;
      addFile(testRel, 'failing_test');
      const testFull = path.join(repoPath, testRel);
      let testContent = null;
      try { testContent = fs.readFileSync(testFull, 'utf8'); } catch { /* ignore */ }
      if (testContent) {
        for (const imp of parseLocalImports(testContent)) {
          const resolved = resolveImport(testRel, imp, repoPath);
          if (resolved && !isTestFile(resolved)) {
            if (addFile(resolved, 'source_under_test')) {
              meta.sourceUnderTestPaths.push(resolved);
            }
          }
        }
      }
    }

    for (const sf of parsed.stackFiles) {
      const norm = normalizeRepoRel(sf, repoPath);
      if (!norm || isTestFile(norm)) continue;
      if (norm.startsWith('node_modules/')) continue;
      if (addFile(norm, 'source_under_test')) {
        meta.sourceUnderTestPaths.push(norm);
      }
    }
  }

  const type = issue.type || '';
  if (type.startsWith('ci_')) {
    for (const wf of listWorkflows(repoPath)) addFile(wf, 'ci_workflow');
  }
  if (type.startsWith('dockerfile_') || analysis.dynamicAnalysis?.kind === 'node' && type === 'dynamic_install_failed') {
    addFile('Dockerfile', 'dockerfile');
  }
  if (type.startsWith('secret_') || type === 'committed_env_file') {
    addFile('.gitignore', 'project_metadata');
  }

  addFile('package.json', 'project_metadata');
  if (analysis.dynamicAnalysis?.kind === 'python') {
    addFile('requirements.txt', 'project_metadata');
  }

  if (existsRel(repoPath, 'package-lock.json')) {
    payload.relevantFiles.push({
      path: 'package-lock.json',
      role: 'project_metadata',
      content_omitted: true,
      reason: 'lockfile included as metadata only',
    });
  }

  payload.source_under_test_resolved = meta.sourceUnderTestPaths.length > 0;
  return { payload, meta };
}

function stripDetails(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    lastStage: d.lastStage ?? null,
    failedStage: d.failedStage ?? null,
    installCommand: d.installCommand ?? null,
    installElapsedMs: d.installElapsedMs ?? null,
    exitCode: d.exitCode ?? null,
    timedOut: !!d.timedOut,
    likelyInstallCause: d.likelyInstallCause ?? null,
    lastNpmActivity: trim(d.lastNpmActivity, 200),
    recentNpmFetches: Array.isArray(d.recentNpmFetches) ? d.recentNpmFetches.slice(-20) : [],
    recentNpmErrors: Array.isArray(d.recentNpmErrors) ? d.recentNpmErrors.slice(-5).map((s) => trim(s, 200)) : [],
    stdoutTail: trim(d.stdoutTail, 2000),
    stderrTail: trim(d.stderrTail, 2000),
  };
}

function listWorkflows(repoPath) {
  const dir = path.join(repoPath, '.github', 'workflows');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
      .map((e) => `.github/workflows/${e.name}`);
  } catch {
    return [];
  }
}

function existsRel(repoPath, relPath) {
  try { return fs.statSync(path.join(repoPath, relPath)).isFile(); }
  catch { return false; }
}

function isTestFile(relPath) {
  return TEST_FILE_RE.test(relPath) || TEST_PATH_RE.test('/' + relPath);
}

function trim(s, max) {
  if (!s) return s || null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

module.exports = {
  SYSTEM_PROMPT,
  userPrompt,
  buildFixContext,
  parseFailingTestFromOutput,
  parseLocalImports,
  resolveImport,
};
