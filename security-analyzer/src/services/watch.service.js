const logger = require('../utils/logger');

const URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

// fullName -> { owner, repo, fullName, url, addedAt }
const watched = new Map();

function parseUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(URL_RE);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (owner === '..' || repo === '..') return null;
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

function add(repositoryUrl) {
  const parsed = parseUrl(repositoryUrl);
  if (!parsed) {
    const e = new Error('Invalid GitHub repository URL.');
    e.code = 'invalid_repo_url';
    e.status = 400;
    throw e;
  }
  const existing = watched.get(parsed.fullName);
  if (existing) {
    return { entry: existing, alreadyExists: true };
  }
  const entry = { ...parsed, addedAt: new Date().toISOString() };
  watched.set(parsed.fullName, entry);
  logger.info('Repository added to watch list', { fullName: parsed.fullName });
  return { entry, alreadyExists: false };
}

function remove(owner, repo) {
  if (!owner || !repo) return false;
  const fullName = `${owner}/${repo}`;
  const had = watched.delete(fullName);
  if (had) logger.info('Repository removed from watch list', { fullName });
  return had;
}

function list() {
  return Array.from(watched.values())
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function isWatched(fullName) {
  return typeof fullName === 'string' && watched.has(fullName);
}

module.exports = { add, remove, list, isWatched, parseUrl };
