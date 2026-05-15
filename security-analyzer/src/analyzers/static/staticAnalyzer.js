const { walk } = require('../../utils/fileWalker');
const secretScanner = require('./secretScanner');
const dockerfileScanner = require('./dockerfileScanner');
const ciScanner = require('./ciScanner');
const packageJsonScanner = require('./packageJsonScanner');
const logger = require('../../utils/logger');

async function analyze(repoPath) {
  const files = [];
  for (const file of walk(repoPath)) files.push(file);

  const results = await Promise.all([
    secretScanner.scan(repoPath, files),
    dockerfileScanner.scan(repoPath, files),
    ciScanner.scan(repoPath, files),
    packageJsonScanner.scan(repoPath, files),
  ]);

  const issues = [].concat(...results);

  logger.info('Static analysis done', {
    checkedFiles: files.length,
    issueCount: issues.length,
  });

  return {
    issues,
    summary: {
      checkedFiles: files.length,
      issueCount: issues.length,
      scanners: ['secrets', 'dockerfile', 'ci', 'packageJson'],
    },
  };
}

module.exports = { analyze };
