// dynamic analysis for node.js projects

const dockerRunner = require('./dockerRunner');
const C = require('../../config/constants');
const {
  parseDynamicStages,
  extractNpmDiagnostics,
  inferInstallCause,
  parseInstallElapsedMs,
  stageSpecificTimeoutMessage,
  stageSpecificTimeoutRecommendation,
  createDynamicIssue,
} = require('./diagnostics');

const IMAGE = 'node:20-alpine';

function npmFlags() {
  const base = '--no-audit --no-fund --no-progress --timing --loglevel=http --fetch-timeout=60000 --fetch-retries=2';
  return process.env.ANALYZER_NPM_IGNORE_SCRIPTS === '1' ? base + ' --ignore-scripts' : base;
}

function buildScript(detection) {
  const flags = npmFlags();
  const installCmd = detection.hasLock ? `npm ci ${flags}` : `npm install ${flags}`;

  const lines = [
    'set -e',
    'echo "STAGE: prepare_workspace"',
    'cp -a /repo/. /work/',
    'cd /work',
    'INSTALL_START=$(date +%s)',
    'echo "STAGE: install_dependencies"',
    `if ! ${installCmd}; then`,
    '  EE=$(date +%s); echo "INSTALL_ELAPSED_MS:$(( (EE - INSTALL_START) * 1000 ))"',
    '  echo "INSTALL_FAILED" >&2; exit 10',
    'fi',
    'EE=$(date +%s); echo "INSTALL_ELAPSED_MS:$(( (EE - INSTALL_START) * 1000 ))"',
  ];

  if (detection.hasBuild) {
    lines.push('echo "STAGE: build"');
    lines.push('if ! npm run build; then echo "BUILD_FAILED" >&2; exit 11; fi');
  }

  if (detection.hasTest) {
    lines.push('echo "STAGE: test"');
    lines.push('if ! npm test --silent; then echo "TEST_FAILED" >&2; exit 12; fi');
  }

  if (detection.hasStart) {
    lines.push('echo "STAGE: start"');
    lines.push('npm start >/tmp/app.log 2>&1 &');
    lines.push('APP_PID=$!');
    lines.push('HEALTH_OK=""');
    lines.push('for i in $(seq 1 15); do');
    lines.push('  for port in 3000 5173 8080; do');
    lines.push('    if wget -q -O /dev/null --timeout=2 --tries=1 "http://127.0.0.1:$port" 2>/dev/null; then');
    lines.push('      HEALTH_OK="$port"; break;');
    lines.push('    fi');
    lines.push('  done');
    lines.push('  if [ -n "$HEALTH_OK" ]; then break; fi');
    lines.push('  sleep 2');
    lines.push('done');
    lines.push('if [ -n "$HEALTH_OK" ]; then echo "HEALTHCHECK_OK:$HEALTH_OK"; else echo "HEALTHCHECK_FAILED" >&2; tail -n 50 /tmp/app.log >&2 || true; fi');
    lines.push('kill $APP_PID 2>/dev/null || true');
    lines.push('wait $APP_PID 2>/dev/null || true');
  }

  lines.push('echo "STAGE: completed"');
  return lines.join('\n');
}

async function run({ repoPath, analysisId, detection }) {
  const containerName = `dsa-node-${analysisId.slice(0, 12)}`;
  const installCommand = detection.hasLock ? 'npm ci' : 'npm install';
  const result = await dockerRunner.execute({
    image: IMAGE,
    repoPath,
    name: containerName,
    command: buildScript(detection),
    timeoutMs: C.DOCKER_TIMEOUT_MS,
  });
  return interpret(result, detection, installCommand);
}

// build the details block attached to every dynamic-issue
function buildDetails(result, installCommand, stages, npmDiag, opts = {}) {
  const installElapsedFromScript = parseInstallElapsedMs(result.stdout);
  const installElapsedMs =
    installElapsedFromScript !== null
      ? installElapsedFromScript
      : (stages.lastStage === 'install_dependencies' ? result.elapsedMs ?? null : null);

  return {
    lastStage: stages.lastStage,
    completedStages: stages.completedStages,
    failedStage: opts.failedStage ?? null,
    installCommand,
    installElapsedMs,
    totalElapsedMs: result.elapsedMs ?? null,
    lastNpmActivity: npmDiag.lastNpmActivity,
    recentNpmFetches: npmDiag.recentNpmFetches,
    recentNpmErrors: npmDiag.recentNpmErrors,
    recentNpmTimings: npmDiag.recentNpmTimings,
    likelyInstallCause: opts.likelyInstallCause ?? null,
    exitCode: opts.exitCode ?? result.code ?? null,
    timedOut: !!result.timedOut,
    stdoutTail: String(result.stdout || '').slice(-4000),
    stderrTail: String(result.stderr || '').slice(-4000),
  };
}

function interpret(result, detection, installCommand) {
  const issues = [];
  let status = 'completed';

  const stages = parseDynamicStages(String(result.stdout || '') + '\n' + String(result.stderr || ''));
  const npmDiag = extractNpmDiagnostics(result.stdout, result.stderr);

  if (result.timedOut) {
    status = 'timeout';
    const cause = inferInstallCause(result.stdout, result.stderr, npmDiag);
    issues.push(createDynamicIssue({
      type: 'dynamic_timeout',
      severity: 'medium',
      message: stageSpecificTimeoutMessage(stages.lastStage),
      recommendation: stageSpecificTimeoutRecommendation(stages.lastStage),
      details: buildDetails(result, installCommand, stages, npmDiag, {
        failedStage: stages.lastStage,
        likelyInstallCause: cause,
        exitCode: null,
      }),
    }));
  } else if (result.code !== 0) {
    status = 'failed';
    if (result.code === 10 || /INSTALL_FAILED/.test(result.stderr || '')) {
      const cause = inferInstallCause(result.stdout, result.stderr, npmDiag);
      issues.push(createDynamicIssue({
        type: 'dynamic_install_failed',
        severity: 'high',
        message: 'Dependency installation failed inside Docker.',
        recommendation: 'Inspect npm stderr/stdout (recentNpmErrors / lastNpmActivity below). Common causes: lockfile mismatch, registry/network failure, ENOSPC on /work, native dependency build failures.',
        details: buildDetails(result, installCommand, stages, npmDiag, {
          failedStage: 'install_dependencies',
          likelyInstallCause: cause,
        }),
      }));
    } else if (result.code === 11 || /BUILD_FAILED/.test(result.stderr || '')) {
      issues.push(createDynamicIssue({
        type: 'dynamic_build_failed',
        severity: 'high',
        message: 'Build (npm run build) failed inside Docker.',
        recommendation: 'Run "npm run build" locally and fix the reported errors. Check the stdout/stderr tails below for the first error.',
        details: buildDetails(result, installCommand, stages, npmDiag, {
          failedStage: 'build',
        }),
      }));
    } else if (result.code === 12 || /TEST_FAILED/.test(result.stderr || '')) {
      issues.push(createDynamicIssue({
        type: 'dynamic_test_failed',
        severity: 'high',
        message: 'Tests (npm test) failed inside Docker.',
        recommendation: 'Run "npm test" locally and resolve failing tests. See stdout/stderr tails below for the failing assertions.',
        details: buildDetails(result, installCommand, stages, npmDiag, {
          failedStage: 'test',
        }),
      }));
    } else {
      issues.push(createDynamicIssue({
        type: 'dynamic_runtime_error',
        severity: 'high',
        message: `Dynamic analysis exited with code ${result.code}.`,
        recommendation: 'Check the captured stdout/stderr in details for context.',
        details: buildDetails(result, installCommand, stages, npmDiag, {
          failedStage: stages.lastStage,
        }),
      }));
    }
  }

  if (status === 'completed' && detection.hasStart && /HEALTHCHECK_FAILED/.test(result.stderr || '')) {
    issues.push(createDynamicIssue({
      type: 'dynamic_healthcheck_failed',
      severity: 'medium',
      message: 'Application started but did not respond on common ports (3000, 5173, 8080).',
      recommendation: 'Verify the port the application binds to and confirm it listens on 0.0.0.0 / 127.0.0.1.',
      details: buildDetails(result, installCommand, stages, npmDiag, {
        failedStage: 'start',
      }),
    }));
  }

  let healthPort = null;
  const m = /HEALTHCHECK_OK:(\d+)/.exec(String(result.stdout || ''));
  if (m) healthPort = parseInt(m[1], 10);

  return {
    issues,
    summary: {
      status,
      kind: 'node',
      ranInstall: true,
      ranBuild: !!detection.hasBuild,
      ranTest: !!detection.hasTest,
      ranStart: !!detection.hasStart,
      installCommand,
      installElapsedMs: parseInstallElapsedMs(result.stdout),
      lastStage: stages.lastStage,
      completedStages: stages.completedStages,
      healthPort,
      timedOut: result.timedOut,
      totalElapsedMs: result.elapsedMs ?? null,
      stdoutTail: String(result.stdout || '').slice(-4000),
      stderrTail: String(result.stderr || '').slice(-4000),
      exitCode: result.code,
    },
  };
}

module.exports = { run, buildScript };
