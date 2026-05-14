const path = require('path');
const { readFileSafe } = require('../../utils/fileWalker');

const SUSPICIOUS = [
  {
    re: /\brm\s+-rf\s+\/(?:\s|$)/,
    type: 'package_json_destructive_rm',
    severity: 'critical',
    msg: 'Script contains a destructive "rm -rf /" command.',
  },
  {
    re: /\bcurl\b[^\n]*\|\s*(?:bash|sh)\b/,
    type: 'package_json_curl_pipe_shell',
    severity: 'high',
    msg: 'Script pipes a curl download into a shell.',
  },
  {
    re: /\bwget\b[^\n]*\|\s*(?:bash|sh)\b/,
    type: 'package_json_wget_pipe_shell',
    severity: 'high',
    msg: 'Script pipes a wget download into a shell.',
  },
  {
    re: /\beval\b\s*[(`"']/,
    type: 'package_json_eval_in_script',
    severity: 'high',
    msg: 'Script uses eval, which executes arbitrary code.',
  },
];

async function scan(repoPath, files) {
  const issues = [];

  for (const file of files) {
    if (path.basename(file.relative) !== 'package.json') continue;

    const content = readFileSafe(file.full);
    if (!content) continue;

    let pkg;
    try {
      pkg = JSON.parse(content);
    } catch (e) {
      issues.push({
        source: 'static',
        type: 'package_json_invalid',
        severity: 'high',
        file: file.relative,
        line: null,
        message: `Invalid package.json: ${e.message}`,
        recommendation: 'Fix the JSON syntax. npm install will fail until package.json parses cleanly.',
      });
      continue;
    }

    if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
      issues.push({
        source: 'static',
        type: 'package_json_invalid',
        severity: 'high',
        file: file.relative,
        line: null,
        message: 'package.json must be a JSON object.',
        recommendation: 'Replace package.json with a valid JSON object.',
      });
      continue;
    }

    const scripts = pkg.scripts || {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== 'string') continue;
      for (const p of SUSPICIOUS) {
        if (p.re.test(cmd)) {
          issues.push({
            source: 'static',
            type: p.type,
            severity: p.severity,
            file: file.relative,
            line: null,
            message: `${p.msg} (script "${name}")`,
            recommendation:
              'Review the script. Replace destructive or remote-execution patterns with safe equivalents.',
          });
        }
      }
    }

    // only check the root package.json for missing build/test
    if (file.relative === 'package.json') {
      const test = (scripts.test || '').toString();
      if (!test || /no test specified/i.test(test) || /\bexit\s+1\b/.test(test)) {
        issues.push({
          source: 'static',
          type: 'package_json_missing_test',
          severity: 'low',
          file: file.relative,
          line: null,
          message: 'No real "test" script is defined in package.json.',
          recommendation: 'Add an automated test script so the pipeline can validate each change.',
        });
      }

      const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
      const isFrontend = !!(deps.next || deps.react || deps.vite || deps['@angular/core'] || deps.svelte);
      if (!scripts.build && isFrontend) {
        issues.push({
          source: 'static',
          type: 'package_json_missing_build',
          severity: 'low',
          file: file.relative,
          line: null,
          message: 'A frontend framework is in dependencies but no "build" script is defined.',
          recommendation: 'Add a "build" script so the deployment pipeline can produce production assets.',
        });
      }
    }
  }

  return issues;
}

module.exports = { scan };
