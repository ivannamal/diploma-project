const path = require('path');
const { readFileSafe } = require('../../utils/fileWalker');

const DANGEROUS_RUN = [
  /\bcurl\s+[^\n]*\|\s*(?:bash|sh)\b/,
  /\bwget\s+[^\n]*\|\s*(?:bash|sh)\b/,
  /\brm\s+-rf\s+\/(\s|$)/,
  /\bchmod\s+777\s+\//,
];

function isDockerfile(name) {
  return /^Dockerfile($|\.|-)/.test(name) || name === 'Containerfile';
}

async function scan(repoPath, files) {
  const issues = [];

  for (const file of files) {
    const base = path.basename(file.relative);
    if (!isDockerfile(base)) continue;

    const content = readFileSafe(file.full);
    if (!content) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // FROM checks
      const fromMatch = /^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?/i.exec(trimmed);
      if (fromMatch) {
        const image = fromMatch[1];
        if (image === 'scratch') continue;
        if (/:latest$/i.test(image)) {
          issues.push({
            source: 'static',
            type: 'dockerfile_latest_image',
            severity: 'medium',
            file: file.relative,
            line: i + 1,
            message: `Dockerfile uses "${image}" — the moving "latest" tag.`,
            recommendation:
              'Pin the image to an immutable version, e.g. node:20-alpine or python:3.10-slim.',
          });
        } else if (!image.includes(':') && !image.includes('@')) {
          issues.push({
            source: 'static',
            type: 'dockerfile_no_tag',
            severity: 'medium',
            file: file.relative,
            line: i + 1,
            message: `Dockerfile uses "${image}" without an explicit tag (defaults to latest).`,
            recommendation: 'Add an explicit version tag, for example node:20-alpine.',
          });
        }
      }

      // RUN checks
      if (/^RUN\b/i.test(trimmed)) {
        for (const p of DANGEROUS_RUN) {
          if (p.test(trimmed)) {
            issues.push({
              source: 'static',
              type: 'dockerfile_dangerous_run',
              severity: 'high',
              file: file.relative,
              line: i + 1,
              message: 'Dockerfile RUN instruction performs a dangerous shell command.',
              recommendation:
                'Avoid piping remote scripts to a shell, removing the root filesystem, or using chmod 777 in build steps.',
            });
            break;
          }
        }
      }
    }
  }

  return issues;
}

module.exports = { scan };
