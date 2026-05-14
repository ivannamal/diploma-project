const os = require('os');
const path = require('path');
const fs = require('fs');

function tmpRoot() {
  if (process.env.ANALYZER_TMP_ROOT) return process.env.ANALYZER_TMP_ROOT;
  // if non-ascii user name
  if (process.platform === 'win32') {
    const drive = process.env.SystemDrive || 'C:';
    return path.join(drive + '\\', 'analyzer-tmp');
  }
  return path.join(os.tmpdir(), 'security-analyzer');
}

function ensureRoot() {
  const root = tmpRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function analysisDir(analysisId) {
  return path.join(ensureRoot(), analysisId);
}

function repoDir(analysisId) {
  return path.join(analysisDir(analysisId), 'repo');
}

// throws if 'target' is not inside 'repoPath'
// to make sure path traversal cannot escape the temporary clone
function assertInsideRepo(repoPath, target) {
  const repoAbs = path.resolve(repoPath);
  const targetAbs = path.resolve(target);
  if (targetAbs !== repoAbs && !targetAbs.startsWith(repoAbs + path.sep)) {
    const e = new Error('Cannot operate outside of the temporary repository.');
    e.code = 'fix_failed';
    e.status = 400;
    throw e;
  }
}

module.exports = { tmpRoot, ensureRoot, analysisDir, repoDir, assertInsideRepo };
