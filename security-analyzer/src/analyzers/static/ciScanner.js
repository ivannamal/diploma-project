const path = require('path');
const fs = require('fs');
const { readFileSafe } = require('../../utils/fileWalker');

const ACTION_REF_RE = /uses:\s*([\w.\-/]+)@([\w./-]+)/g;

async function scan(repoPath, files) {
  const issues = [];

  const workflowFiles = files.filter((f) =>
    /^\.github\/workflows\/.+\.ya?ml$/i.test(f.relative)
  );
  if (workflowFiles.length === 0) return issues;

  const hasLockfile = fs.existsSync(path.join(repoPath, 'package-lock.json'));

  for (const file of workflowFiles) {
    const content = readFileSafe(file.full);
    if (!content) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/\bcurl\b[^\n]*\|\s*(?:bash|sh)\b/.test(line)) {
        issues.push({
          source: 'static',
          type: 'ci_curl_pipe_shell',
          severity: 'high',
          file: file.relative,
          line: i + 1,
          message: 'CI workflow downloads a script via curl and pipes it to a shell.',
          recommendation:
            'Pin the script to a known version, verify its checksum, or use an official action.',
        });
      }
      if (/\bwget\b[^\n]*\|\s*(?:bash|sh)\b/.test(line)) {
        issues.push({
          source: 'static',
          type: 'ci_wget_pipe_shell',
          severity: 'high',
          file: file.relative,
          line: i + 1,
          message: 'CI workflow downloads a script via wget and pipes it to a shell.',
          recommendation:
            'Pin the script to a known version, verify its checksum, or use an official action.',
        });
      }

      // match only bare "npm install"
      if (/\bnpm\s+install\s*$/.test(line.trimEnd())) {
        if (hasLockfile) {
          issues.push({
            source: 'static',
            type: 'ci_npm_install_with_lockfile',
            severity: 'medium',
            file: file.relative,
            line: i + 1,
            message: 'CI uses "npm install" while a package-lock.json is present.',
            recommendation:
              'Use "npm ci" in CI to install exactly the versions from the lockfile.',
          });
        }
      }
    }

    // detect actions pinned to moving branches.
    for (const m of content.matchAll(ACTION_REF_RE)) {
      const action = m[1];
      const ref = m[2];
      if (ref === 'main' || ref === 'master' || ref === 'develop') {
        const upTo = content.slice(0, m.index);
        const lineNo = upTo.split('\n').length;
        issues.push({
          source: 'static',
          type: 'ci_action_unpinned',
          severity: 'medium',
          file: file.relative,
          line: lineNo,
          message: `Action "${action}" is pinned to the moving branch "@${ref}".`,
          recommendation:
            'Pin the action to a tagged release or a full commit SHA for supply-chain stability.',
        });
      }
    }

    // if a Node setup is present but no build/test step is defined
    if (/setup-node@/.test(content)) {
      const hasBuildOrTest =
        /\bnpm\s+(?:run\s+)?(?:build|test)\b/.test(content) ||
        /\bnpm\s+ci\b/.test(content) ||
        /\byarn\s+(?:install|build|test)\b/.test(content) ||
        /\bpnpm\s+(?:install|build|test)\b/.test(content);
      if (!hasBuildOrTest) {
        issues.push({
          source: 'static',
          type: 'ci_missing_build_test',
          severity: 'low',
          file: file.relative,
          line: null,
          message: 'CI workflow sets up Node.js but does not appear to run build or test steps.',
          recommendation:
            'Add an "npm ci" plus "npm test" / "npm run build" step to validate every change.',
        });
      }
    }
  }

  return issues;
}

module.exports = { scan };
