const fs = require('fs');
const path = require('path');

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function detect(repoPath) {
  if (exists(path.join(repoPath, 'package.json'))) {
    const pkg = readJson(path.join(repoPath, 'package.json')) || {};
    const scripts = (pkg && typeof pkg === 'object' && pkg.scripts) || {};
    const hasLock = exists(path.join(repoPath, 'package-lock.json'));
    return {
      kind: 'node',
      hasLock,
      hasTest: !!scripts.test && !/no test specified/i.test(scripts.test) && !/\bexit\s+1\b/.test(scripts.test),
      hasBuild: !!scripts.build,
      hasStart: !!scripts.start,
    };
  }

  const pyMarkers = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'app.py', 'main.py'];
  for (const m of pyMarkers) {
    if (exists(path.join(repoPath, m))) {
      return {
        kind: 'python',
        hasRequirements: exists(path.join(repoPath, 'requirements.txt')),
        hasFlaskHint: detectFlask(repoPath),
        entry: detectPyEntry(repoPath),
      };
    }
  }

  return { kind: 'unknown', reason: 'no recognised manifest' };
}

function detectFlask(repoPath) {
  for (const c of ['app.py', 'main.py', 'wsgi.py', 'application.py']) {
    const p = path.join(repoPath, c);
    if (!exists(p)) continue;
    try {
      const txt = fs.readFileSync(p, 'utf8');
      if (/\bfrom\s+flask\b|\bimport\s+flask\b/.test(txt)) return true;
    } catch { /* ignore */ }
  }
  try {
    const r = fs.readFileSync(path.join(repoPath, 'requirements.txt'), 'utf8');
    if (/\bflask\b/i.test(r)) return true;
  } catch { }
  return false;
}

function detectPyEntry(repoPath) {
  for (const c of ['app.py', 'main.py', 'wsgi.py', 'application.py']) {
    if (exists(path.join(repoPath, c))) return c;
  }
  return null;
}

module.exports = { detect };
