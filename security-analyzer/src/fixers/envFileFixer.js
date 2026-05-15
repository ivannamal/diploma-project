const fs = require('fs');
const path = require('path');
const { unifiedDiff, fileRemovedDiff } = require('../utils/diff');
const { assertInsideRepo } = require('../utils/paths');

async function apply({ analysis, issue }) {
  if (!issue.file) {
    throw makeErr('Issue has no file path; cannot apply env-file fix.');
  }
  const repoPath = analysis.repoPath;
  const target = path.join(repoPath, issue.file);
  assertInsideRepo(repoPath, target);

  const changedFiles = [];
  const diffs = [];

  // remove the committed .env file from the temporary copy
  let envBefore = '';
  try { envBefore = fs.readFileSync(target, 'utf8'); } catch { /* ignore */ }
  if (fs.existsSync(target)) {
    fs.rmSync(target);
    diffs.push(fileRemovedDiff(envBefore, issue.file));
    changedFiles.push(issue.file);
  }

  // ensure .env is in .gitignore
  const gitignorePath = path.join(repoPath, '.gitignore');
  let before = '';
  try { before = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* may not exist */ }

  const lines = before ? before.split(/\r?\n/) : [];
  const trimmedSet = new Set(lines.map((l) => l.trim()));
  const baseName = path.basename(issue.file);
  const wanted = new Set(['.env']);
  if (baseName !== '.env') wanted.add(baseName);

  let mutated = false;
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const w of wanted) {
    if (!trimmedSet.has(w)) {
      lines.push(w);
      mutated = true;
    }
  }

  if (mutated) {
    const after = lines.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, after, 'utf8');
    diffs.push(unifiedDiff(before, after, '.gitignore'));
    changedFiles.push('.gitignore');
  }

  return {
    changedFiles,
    diff: diffs.join('\n\n'),
    message: 'Removed committed .env from temporary repository copy and updated .gitignore.',
  };
}

function makeErr(msg) {
  const e = new Error(msg);
  e.code = 'fix_failed';
  e.status = 400;
  return e;
}

module.exports = { apply };
