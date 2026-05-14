//return files that are useful to analyze

const fs = require('fs');
const path = require('path');
const { MAX_FILE_SIZE_BYTES, MAX_TOTAL_FILES } = require('../config/constants');

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.cache', 'vendor', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', 'target', 'bin', 'obj',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi', '.mkv',
  '.ttf', '.woff', '.woff2', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
  '.psd', '.ai', '.sketch',
]);

// big files with little-to-no info
// their existence is checked separately where it matters
const SKIP_FILES_FULL = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Pipfile.lock', 'poetry.lock', 'composer.lock',
]);

function* walk(rootDir) {
  const stack = [rootDir];
  let count = 0;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        if (++count > MAX_TOTAL_FILES) return;

        const ext = path.extname(ent.name).toLowerCase();
        if (BINARY_EXT.has(ext)) continue;
        if (SKIP_FILES_FULL.has(ent.name)) continue;

        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;

        yield {
          full,
          relative: path.relative(rootDir, full).replace(/\\/g, '/'),
          name: ent.name,
          size: stat.size,
        };
      }
    }
  }
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

module.exports = { walk, readFileSafe, SKIP_DIRS, BINARY_EXT };
