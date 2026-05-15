// builds the `details` object from if dynamic analysis fails

const STAGE_RE = /^STAGE:\s*([A-Za-z_][\w]*)\s*$/;
const INSTALL_ELAPSED_RE = /INSTALL_ELAPSED_MS:(\d+)/;

const NPM_INTERESTING_TOKENS = [
  'npm http fetch',
  'npm timing',
  'npm ERR',
  'gyp',
  'node-gyp',
  'postinstall',
  'preinstall',
  'tarball',
  'cache',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'ERR_SOCKET_TIMEOUT',
  'No space left on device',
  'ENOSPC',
  'permission denied',
  'EACCES',
];

// searches for "STAGE:" lines
function parseDynamicStages(output) {
  const lines = String(output || '').split(/\r?\n/);
  const stages = [];
  for (const line of lines) {
    const m = STAGE_RE.exec(line.trim());
    if (m) stages.push(m[1]);
  }
  return {
    allStages: stages,
    completedStages: stages.length > 1 ? stages.slice(0, -1) : [], //evrth except last
    lastStage: stages.length ? stages[stages.length - 1] : null,
  };
}

// get package name out of a npm http fetch URL.
// example:
// - input: npm http fetch GET 200 https://registry.npmjs.org/react 120ms
// - output: react
function extractPackageFromNpmFetchLine(line) {
  if (!line) return null;
  const urlMatch = /https?:\/\/[^\s]+/.exec(line);
  if (!urlMatch) return null;
  let url = urlMatch[0].replace(/[?#].*$/, '');
  const m = /\/\/[^/]+\/(.+)$/.exec(url);
  if (!m) return null;
  let path;
  try { path = decodeURIComponent(m[1]); } catch { path = m[1]; }
  path = path.replace(/%2[Ff]/g, '/');
  const dashIdx = path.indexOf('/-/');
  if (dashIdx !== -1) path = path.slice(0, dashIdx);
  if (path.startsWith('@')) {
    const parts = path.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return path.split('/')[0];
}

// get out npm-interesting lines from stdout+stderr
function extractNpmDiagnostics(stdout, stderr) {
  const lines = (String(stdout || '') + '\n' + String(stderr || '')).split(/\r?\n/);

  const allFetches = [];
  const errors = [];
  const timings = [];
  let lastNpmActivity = null;

  for (const line of lines) {
    let interesting = false;
    if (line.includes('npm http fetch')) {
      const pkg = extractPackageFromNpmFetchLine(line);
      if (pkg) allFetches.push(pkg);
      interesting = true;
    }
    if (line.includes('npm ERR') ||
        /(?:ENOSPC|EACCES|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ERR_SOCKET_TIMEOUT)/.test(line) ||
        /No space left on device/i.test(line) ||
        /permission denied/i.test(line)) {
      errors.push(line.trim());
      interesting = true;
    }
    if (line.includes('npm timing')) {
      timings.push(line.trim());
      interesting = true;
    }
    if (!interesting) {
      for (const tok of NPM_INTERESTING_TOKENS) {
        if (line.includes(tok)) { interesting = true; break; }
      }
    }
    if (interesting && line.trim()) lastNpmActivity = line.trim();
  }

  // remove duplicate fetches, keep last 20 most-recent
  const seen = new Set();
  const fetches = [];
  for (let i = allFetches.length - 1; i >= 0; i--) {
    const p = allFetches[i];
    if (seen.has(p)) continue;
    seen.add(p);
    fetches.unshift(p);
    if (fetches.length >= 20) break;
  }

  return {
    lastNpmActivity,
    recentNpmFetches: fetches,
    recentNpmErrors: errors.slice(-10),
    recentNpmTimings: timings.slice(-10),
  };
}

// "why did it fail / time out" inference
function inferInstallCause(stdout, stderr, npmDiag) {
  const combined = String(stdout || '') + '\n' + String(stderr || '');

  if (/ENOSPC|No space left on device/i.test(combined)) {
    return 'The Docker workspace or npm cache ran out of space.';
  }
  if (/EACCES|permission denied/i.test(combined)) {
    return 'npm could not write to a required directory inside the container.';
  }
  if (/(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ERR_SOCKET_TIMEOUT)/.test(combined)) {
    return 'npm was waiting on network or registry downloads.';
  }
  if (/\b(?:node-gyp|gyp|sharp|canvas|sqlite3|bcrypt|esbuild|swc)\b/i.test(combined)) {
    return 'Installation may be compiling or preparing native dependencies.';
  }
  const fetches = (npmDiag && npmDiag.recentNpmFetches) || [];
  const errs = (npmDiag && npmDiag.recentNpmErrors) || [];
  if (fetches.length > 0 && errs.length === 0) {
    return 'Dependency installation was still downloading packages when the timeout happened.';
  }
  if (fetches.length === 0 && errs.length === 0 && !(npmDiag && npmDiag.lastNpmActivity)) {
    return 'npm produced no useful output before timeout. The process may have stalled early.';
  }
  return null;
}

function parseInstallElapsedMs(stdout) {
  const m = INSTALL_ELAPSED_RE.exec(String(stdout || ''));
  return m ? parseInt(m[1], 10) : null;
}

function stageSpecificTimeoutMessage(lastStage) {
  switch (lastStage) {
    case 'prepare_workspace':
      return 'Dynamic analysis exceeded the time limit while preparing the workspace.';
    case 'install_dependencies':
      return 'Dynamic analysis exceeded the time limit during dependency installation.';
    case 'build':
      return 'Dynamic analysis exceeded the time limit during build.';
    case 'test':
      return 'Dynamic analysis exceeded the time limit during test execution.';
    case 'start':
      return 'Dynamic analysis exceeded the time limit while waiting for the app to become healthy.';
    case 'compile':
      return 'Dynamic analysis exceeded the time limit during Python compileall.';
    default:
      return 'Dynamic analysis exceeded the time limit.';
  }
}

function stageSpecificTimeoutRecommendation(lastStage) {
  switch (lastStage) {
    case 'install_dependencies':
      return 'Check npm logs (lastNpmActivity / recentNpmFetches / recentNpmErrors), verify registry and network access, look for native dependency builds (node-gyp), confirm Docker workspace/cache space, or raise DOCKER_TIMEOUT_MS.';
    case 'build':
      return 'Inspect "npm run build" output. The build may be stuck on a slow bundler step, memory-starved, or waiting on a child process.';
    case 'test':
      return 'Inspect "npm test" output. Tests may have a hung server, an infinite loop, or a missing teardown.';
    case 'start':
      return 'The app started but did not respond within the health-check window. Verify the bound host/port and startup time.';
    case 'compile':
      return 'Reproduce "python -m compileall ." locally to find the file that hangs the compiler.';
    default:
      return 'Speed up the install/build steps or run dynamic analysis with a longer-lived runner.';
  }
}

function createDynamicIssue({
  type,
  severity,
  message,
  recommendation,
  details = null,
}) {
  const issue = {
    source: 'dynamic',
    type,
    severity,
    file: null,
    line: null,
    message,
    recommendation,
  };
  if (details) issue.details = details;
  return issue;
}

module.exports = {
  parseDynamicStages,
  extractNpmDiagnostics,
  extractPackageFromNpmFetchLine,
  inferInstallCause,
  parseInstallElapsedMs,
  stageSpecificTimeoutMessage,
  stageSpecificTimeoutRecommendation,
  createDynamicIssue,
};
