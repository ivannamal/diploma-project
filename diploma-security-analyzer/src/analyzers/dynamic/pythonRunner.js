const dockerRunner = require('./dockerRunner');
const C = require('../../config/constants');
const {
  parseDynamicStages,
  stageSpecificTimeoutMessage,
  stageSpecificTimeoutRecommendation,
  createDynamicIssue,
} = require('./diagnostics');

const IMAGE = 'python:3.10-slim';

// python:3.10-slim has neither curl nor wget pre-installed, so the
// in-container health check uses urllib.request from Python itself
function buildScript(detection) {
  const lines = [
    'set -e',
    'echo "STAGE: prepare_workspace"',
    'cp -a /repo/. /work/',
    'cd /work',
    'echo "STAGE: compile"',
    'if ! python -m compileall -q .; then echo "COMPILE_FAILED" >&2; exit 10; fi',
  ];

  if (detection.hasRequirements) {
    lines.push('INSTALL_START=$(date +%s)');
    lines.push('echo "STAGE: install_dependencies"');
    lines.push('if ! python -m pip install --quiet --disable-pip-version-check --no-input --timeout 60 -r requirements.txt; then');
    lines.push('  EE=$(date +%s); echo "INSTALL_ELAPSED_MS:$(( (EE - INSTALL_START) * 1000 ))"');
    lines.push('  echo "INSTALL_FAILED" >&2; exit 11');
    lines.push('fi');
    lines.push('EE=$(date +%s); echo "INSTALL_ELAPSED_MS:$(( (EE - INSTALL_START) * 1000 ))"');
  }

  if (detection.hasFlaskHint && detection.entry) {
    lines.push('echo "STAGE: start"');
    lines.push(`FLASK_APP=${detection.entry} python -m flask run --host=127.0.0.1 --port=5000 >/tmp/app.log 2>&1 &`);
    lines.push('APP_PID=$!');
    lines.push('HEALTH_OK=""');
    lines.push('for i in $(seq 1 15); do');
    lines.push("  if python -c \"import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:5000', timeout=2); sys.exit(0)\" 2>/dev/null; then");
    lines.push('    HEALTH_OK="5000"; break;');
    lines.push('  fi');
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
  const containerName = `dsa-py-${analysisId.slice(0, 12)}`;
  const result = await dockerRunner.execute({
    image: IMAGE,
    repoPath,
    name: containerName,
    command: buildScript(detection),
    timeoutMs: C.DOCKER_TIMEOUT_MS,
  });
  return interpret(result, detection);
}

function buildDetails(result, stages, opts = {}) {
  return {
    lastStage: stages.lastStage,
    completedStages: stages.completedStages,
    failedStage: opts.failedStage ?? null,
    installCommand: opts.installCommand ?? null,
    installElapsedMs: opts.installElapsedMs ?? null,
    totalElapsedMs: result.elapsedMs ?? null,
    likelyInstallCause: opts.likelyInstallCause ?? null,
    exitCode: opts.exitCode ?? result.code ?? null,
    timedOut: !!result.timedOut,
    stdoutTail: String(result.stdout || '').slice(-4000),
    stderrTail: String(result.stderr || '').slice(-4000),
  };
}

function interpret(result, detection) {
  const issues = [];
  let status = 'completed';

  const stages = parseDynamicStages(
    String(result.stdout || '') + '\n' + String(result.stderr || '')
  );
  const installCommand = detection.hasRequirements ? 'pip install -r requirements.txt' : null;

  if (result.timedOut) {
    status = 'timeout';
    issues.push(createDynamicIssue({
      type: 'dynamic_timeout',
      severity: 'medium',
      message: stageSpecificTimeoutMessage(stages.lastStage),
      recommendation: stageSpecificTimeoutRecommendation(stages.lastStage),
      details: buildDetails(result, stages, {
        failedStage: stages.lastStage,
        installCommand,
        exitCode: null,
      }),
    }));
  } else if (result.code !== 0) {
    status = 'failed';
    if (result.code === 10 || /COMPILE_FAILED/.test(result.stderr || '')) {
      issues.push(createDynamicIssue({
        type: 'dynamic_compile_failed',
        severity: 'high',
        message: 'Python compileall failed: there is at least one syntax error in the project.',
        recommendation: 'Run "python -m compileall ." locally and fix the reported syntax errors.',
        details: buildDetails(result, stages, { failedStage: 'compile' }),
      }));
    } else if (result.code === 11 || /INSTALL_FAILED/.test(result.stderr || '')) {
      issues.push(createDynamicIssue({
        type: 'dynamic_install_failed',
        severity: 'high',
        message: 'pip install -r requirements.txt failed.',
        recommendation: 'Inspect pip output (stderr tail below). Common causes: pinned versions, network issues, missing system dependencies.',
        details: buildDetails(result, stages, {
          failedStage: 'install_dependencies',
          installCommand,
        }),
      }));
    } else {
      issues.push(createDynamicIssue({
        type: 'dynamic_runtime_error',
        severity: 'high',
        message: `Dynamic analysis exited with code ${result.code}.`,
        recommendation: 'Check the captured stdout/stderr in details for context.',
        details: buildDetails(result, stages, { failedStage: stages.lastStage }),
      }));
    }
  }

  if (status === 'completed' && detection.hasFlaskHint && /HEALTHCHECK_FAILED/.test(result.stderr || '')) {
    issues.push(createDynamicIssue({
      type: 'dynamic_healthcheck_failed',
      severity: 'medium',
      message: 'Flask app did not respond on http://127.0.0.1:5000 after start.',
      recommendation: 'Verify FLASK_APP is set correctly and that the application starts cleanly.',
      details: buildDetails(result, stages, { failedStage: 'start' }),
    }));
  }

  let healthPort = null;
  const m = /HEALTHCHECK_OK:(\d+)/.exec(String(result.stdout || ''));
  if (m) healthPort = parseInt(m[1], 10);

  return {
    issues,
    summary: {
      status,
      kind: 'python',
      ranCompile: true,
      ranInstall: !!detection.hasRequirements,
      ranStart: !!detection.hasFlaskHint,
      installCommand,
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
