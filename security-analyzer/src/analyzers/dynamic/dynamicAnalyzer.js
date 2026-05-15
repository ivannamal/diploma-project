const projectDetector = require('./projectDetector');
const nodeRunner = require('./nodeRunner');
const pythonRunner = require('./pythonRunner');
const dockerRunner = require('./dockerRunner');
const logger = require('../../utils/logger');

async function analyze(repoPath, ctx) {
  const detection = projectDetector.detect(repoPath);

  if (detection.kind === 'unknown') {
    return {
      issues: [{
        source: 'dynamic',
        type: 'dynamic_skipped_unknown',
        severity: 'medium',
        file: null, line: null,
        message: 'Could not detect project kind. Dynamic analysis was skipped.',
        recommendation:
          'Add a recognised manifest (package.json, requirements.txt, pyproject.toml, etc.) so dynamic checks can run.',
      }],
      summary: { status: 'skipped', kind: 'unknown', reason: detection.reason },
    };
  }

  const dockerOk = await dockerRunner.checkAvailable();
  if (!dockerOk.available) {
    logger.warn('Docker unavailable, skipping dynamic analysis', { reason: dockerOk.reason });
    return {
      issues: [{
        source: 'dynamic',
        type: 'dynamic_docker_unavailable',
        severity: 'medium',
        file: null, line: null,
        message: `Docker is not available on this host: ${dockerOk.reason}.`,
        recommendation:
          'Install and start Docker Desktop to enable dynamic analysis. Static checks still applied.',
      }],
      summary: { status: 'skipped', kind: detection.kind, reason: 'docker_unavailable' },
    };
  }

  let runner;
  if (detection.kind === 'node') runner = nodeRunner;
  else if (detection.kind === 'python') runner = pythonRunner;
  else {
    return {
      issues: [],
      summary: { status: 'skipped', kind: detection.kind, reason: 'no_runner' },
    };
  }

  const result = await runner.run({ repoPath, analysisId: ctx.analysisId, detection });
  logger.info('Dynamic analysis done', { status: result.summary.status, kind: detection.kind });
  return result;
}

module.exports = { analyze };
