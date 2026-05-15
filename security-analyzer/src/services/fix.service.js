const stateService = require('./state.service');
const envFileFixer = require('../fixers/envFileFixer');
const ciFixer = require('../fixers/ciFixer');
const dockerfileFixer = require('../fixers/dockerfileFixer');
const packageJsonFixer = require('../fixers/packageJsonFixer');
const genericFixer = require('../fixers/genericFixer');

function pickFixer(issue) {
  switch (issue.type) {
    case 'committed_env_file':
      return envFileFixer;
    case 'ci_npm_install_with_lockfile':
      return ciFixer;
    case 'dockerfile_latest_image':
    case 'dockerfile_no_tag':
    case 'dockerfile_dangerous_run':
      return dockerfileFixer;
    case 'package_json_invalid':
    case 'package_json_destructive_rm':
    case 'package_json_curl_pipe_shell':
    case 'package_json_wget_pipe_shell':
    case 'package_json_eval_in_script':
    case 'package_json_missing_test':
    case 'package_json_missing_build':
      return packageJsonFixer;
    default:
      return genericFixer;
  }
}

async function applyFix(analysisId, issueId) {
  const analysis = stateService.get(analysisId);
  if (!analysis) {
    const e = new Error('Analysis not found or expired.');
    e.code = 'not_found'; e.status = 404; throw e;
  }
  const issue = (analysis.issues || []).find((i) => i.id === issueId);
  if (!issue) {
    const e = new Error('Issue not found in the given analysis.');
    e.code = 'not_found'; e.status = 404; throw e;
  }
  if (issue.status === 'fixed') {
    return {
      issueId,
      status: 'fixed',
      changedFiles: [],
      diff: '',
      message: 'Issue is already marked as fixed.',
    };
  }
  if (!issue.fix || !issue.fix.available || !issue.fix.safe) {
    const e = new Error('This issue cannot be auto-fixed. Manual remediation is required.');
    e.code = 'fix_not_safe'; e.status = 400; throw e;
  }

  const fixer = pickFixer(issue);
  const result = await fixer.apply({ analysis, issue });

  issue.status = 'fixed';
  issue.fix.applied_at = new Date().toISOString();

  return {
    issueId,
    status: 'fixed',
    changedFiles: result.changedFiles,
    diff: result.diff,
    message: result.message || 'Fix applied to temporary repository copy.',
  };
}

module.exports = { applyFix };
