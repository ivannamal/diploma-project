const fs = require('fs');
const path = require('path');
const { unifiedDiff } = require('../utils/diff');
const { assertInsideRepo } = require('../utils/paths');

async function apply({ analysis, issue }) {
  if (!issue.file) throw makeErr('Issue has no file path; cannot apply CI fix.');

  const repoPath = analysis.repoPath;
  const lockExists = fs.existsSync(path.join(repoPath, 'package-lock.json'));
  if (!lockExists) {
    throw makeErr('Refusing auto-fix: package-lock.json is no longer present in the working copy.');
  }

  const target = path.join(repoPath, issue.file);
  assertInsideRepo(repoPath, target);

  const before = fs.readFileSync(target, 'utf8');
  const lines = before.split(/\r?\n/);

  // replace only when "npm install" sits at the end of the line (no positional
  // package argument and no -g / --global)
  const replaceLine = (idx) => {
    const original = lines[idx];
    if (typeof original !== 'string') return false;
    if (!/\bnpm\s+install\s*$/.test(original.trimEnd())) return false;
    if (/\b(?:-g|--global)\b/.test(original)) return false;
    lines[idx] = original.replace(/\bnpm\s+install\s*$/, 'npm ci');
    return lines[idx] !== original;
  };

  let changed = false;
  if (issue.line && replaceLine(issue.line - 1)) {
    changed = true;
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (replaceLine(i)) changed = true;
    }
  }

  if (!changed) {
    throw makeErr('No "npm install" occurrence was modified; auto-fix aborted.');
  }

  const after = lines.join('\n');
  fs.writeFileSync(target, after, 'utf8');

  return {
    changedFiles: [issue.file],
    diff: unifiedDiff(before, after, issue.file),
    message: 'Replaced "npm install" with "npm ci" on the flagged CI line.',
  };
}

function makeErr(msg) {
  const e = new Error(msg);
  e.code = 'fix_failed';
  e.status = 400;
  return e;
}

module.exports = { apply };
