// clones the repo to disk

const fs = require('fs');
const { run } = require('../utils/command');
const { GIT_CLONE_TIMEOUT_MS } = require('../config/constants');
const { analysisDir, repoDir, ensureRoot } = require('../utils/paths');
const logger = require('../utils/logger');

// https://github.com/<owner>/<repo>(.git)?/?
const URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

function validateUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(URL_RE);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (owner === '..' || repo === '..') return null;
  return {
    owner, repo,
    canonical: `https://github.com/${owner}/${repo}.git`,
    display: `https://github.com/${owner}/${repo}`,
  };
}

async function cloneRepository(repoUrl, analysisId) {
  const validated = validateUrl(repoUrl);
  if (!validated) {
    const err = new Error('Only public https://github.com/{user}/{repo} URLs are supported.');
    err.code = 'invalid_repo_url';
    err.status = 400;
    throw err;
  }

  ensureRoot();
  const aDir = analysisDir(analysisId);
  fs.mkdirSync(aDir, { recursive: true });
  const target = repoDir(analysisId);

  // cloning of the repo (single branch)
  const result = await run('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'protocol.version=2',
    'clone',
    '--depth', '1',
    '--single-branch',
    validated.canonical, target,
  ], {
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
    maxOutputBytes: 64_000,
  });

  if (result.code !== 0) {
    const err = new Error(`git clone failed: ${(result.stderr || '').slice(0, 400) || 'unknown error'}`);
    err.code = result.timedOut ? 'clone_timeout' : 'clone_failed';
    err.status = 400;
    fs.rmSync(aDir, { recursive: true, force: true });
    throw err;
  }

  logger.info('Repository cloned', { analysisId, repoUrl: validated.display });
  return {
    repoPath: target,
    repository: validated.display,
    owner: validated.owner,
    name: validated.repo,
  };
}

function cleanupRepository(analysisId) {
  const aDir = analysisDir(analysisId);
  fs.rm(aDir, { recursive: true, force: true }, () => {});
}

module.exports = { validateUrl, cloneRepository, cleanupRepository };
