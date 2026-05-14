const watchService = require('../services/watch.service');
const pollService = require('../services/poll.service');
const logger = require('../utils/logger');

function add(req, res) {
  const { repository } = req.body || {};
  if (!repository || typeof repository !== 'string') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'repository is required (https://github.com/owner/repo).',
    });
  }
  try {
    const { entry, alreadyExists } = watchService.add(repository);
    res.status(alreadyExists ? 200 : 201).json({
      ok: true,
      alreadyExists,
      message: alreadyExists
        ? 'Repository is already being watched.'
        : 'Repository is now being watched for pull requests.',
      repository: entry,
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.code || 'watch_failed',
      message: err.message,
    });
  }
}

function list(req, res) {
  res.json({ watched: watchService.list() });
}

function remove(req, res) {
  const { owner, repo } = req.params;
  if (!owner || !repo) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'owner and repo path parameters are required.',
    });
  }
  const had = watchService.remove(owner, repo);
  if (!had) {
    return res.status(404).json({
      error: 'not_found',
      message: `Repository "${owner}/${repo}" is not being watched.`,
    });
  }
  res.json({
    ok: true,
    message: `Repository "${owner}/${repo}" removed from the watch list.`,
  });
}

async function checkNow(req, res) {
  try {
    const result = await pollService.checkNow();
    // 409 when a previous check is still running
    const status = result.ok ? 200 : 409;
    res.status(status).json(result);
  } catch (err) {
    logger.error('Manual poll check-now failed', err);
    res.status(500).json({
      error: 'check_failed',
      message: err.message,
    });
  }
}

module.exports = { add, list, remove, checkNow };
