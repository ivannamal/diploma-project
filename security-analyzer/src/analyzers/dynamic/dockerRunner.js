const { run } = require('../../utils/command');
const C = require('../../config/constants');
const dockerCfg = require('../../config/docker');
const logger = require('../../utils/logger');

async function checkAvailable() {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 8_000,
    maxOutputBytes: 8_000,
  });
  if (r.code !== 0) {
    return {
      available: false,
      reason: (r.stderr || r.error || '').split('\n')[0] || `docker exited with code ${r.code}`,
    };
  }
  return { available: true, version: r.stdout.trim() };
}

async function execute({ image, repoPath, name, command, timeoutMs = C.DOCKER_TIMEOUT_MS }) {
  const args = dockerCfg.buildRunArgs({ image, repoPath, name, command });
  logger.debug('docker run', { name, image });

  const startedAt = Date.now();
  const result = await run('docker', args, {
    timeoutMs,
    maxOutputBytes: C.DOCKER_OUTPUT_LIMIT_BYTES,
  });
  result.elapsedMs = Date.now() - startedAt;

  //cleanup
  if (result.timedOut || result.code === -1) {
    run('docker', ['rm', '-f', name], { timeoutMs: 5_000, maxOutputBytes: 4_000 })
      .catch(() => { });
  }
  return result;
}

module.exports = { checkAvailable, execute };
