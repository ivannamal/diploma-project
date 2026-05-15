//add autofix or comment on how user can fix it manually

const SAFE_AUTOFIX_TYPES = new Set([
  'committed_env_file',
  'ci_npm_install_with_lockfile',
]);

function describeAutofix(type) {
  switch (type) {
    case 'committed_env_file':
      return {
        strategy: 'remove_file',
        description:
          'Remove the committed .env file from the temporary repository copy and ensure ".env" is listed in .gitignore.',
      };
    case 'ci_npm_install_with_lockfile':
      return {
        strategy: 'replace_text',
        description:
          'Replace "npm install" with "npm ci" on the flagged line in the workflow file (only if package-lock.json is still present).',
      };
    default:
      return null;
  }
}

function manualHint(issue) {
  // defaults for known categories.
  if (issue.type && issue.type.startsWith('secret_')) {
    return 'Auto-replacing secrets is not safe. Move the value to an environment variable, rotate the credential, and remove it from history.';
  }
  if (issue.type === 'dockerfile_latest_image' || issue.type === 'dockerfile_no_tag') {
    return 'Pin the base image to a specific, vetted version (e.g. node:20-alpine). The system does not guess versions for you.';
  }
  if (issue.type === 'dockerfile_dangerous_run') {
    return 'Replace the dangerous RUN command with a safe equivalent or remove it. Manual review required.';
  }
  if (issue.type === 'package_json_invalid') {
    return 'Fix the JSON syntax manually. Auto-mutating an invalid package.json risks corrupting the project.';
  }
  if (issue.type && issue.type.startsWith('dynamic_build_failed')) {
    return 'Reproduce the failure locally with "npm run build" and fix the underlying error.';
  }
  if (issue.type === 'dynamic_test_failed') {
    return 'Reproduce the failure locally with "npm test" and fix the failing tests.';
  }
  if (issue.type === 'dynamic_install_failed') {
    return 'Reproduce installation locally and resolve dependency, registry, or platform issues.';
  }
  if (issue.type === 'dynamic_compile_failed') {
    return 'Reproduce locally with "python -m compileall ." and fix the syntax errors.';
  }
  if (issue.type === 'dynamic_timeout') {
    return 'Reduce install/build time or run analysis with a longer budget. Manual review required.';
  }
  if (issue.type === 'dynamic_skipped_unknown' || issue.type === 'dynamic_docker_unavailable') {
    return 'Manual review required: dynamic analysis could not be performed.';
  }
  if (issue.type === 'dynamic_healthcheck_failed') {
    return 'Verify the application binds to the expected port and address. Manual review required.';
  }
  if (issue.type && issue.type.startsWith('package_json_')) {
    return 'Review the script manually. Automatic deletion of project scripts is not safe.';
  }
  if (issue.type === 'ci_curl_pipe_shell' || issue.type === 'ci_wget_pipe_shell') {
    return 'Replace the piped script with a checksum-verified download or an official action. Manual review required.';
  }
  if (issue.type === 'ci_action_unpinned') {
    return 'Pin the action to a tagged release or full commit SHA. Manual review required.';
  }
  if (issue.type === 'ci_missing_build_test') {
    return 'Add an "npm ci" + "npm test" / "npm run build" step. Manual change required.';
  }
  return issue.recommendation || 'Manual remediation required.';
}

function enrich(issue) {
  if (SAFE_AUTOFIX_TYPES.has(issue.type)) {
    const desc = describeAutofix(issue.type);
    issue.fix = {
      available: true,
      strategy: desc.strategy,
      description: desc.description,
      safe: true,
    };
    return;
  }

  issue.fix = {
    available: false,
    strategy: 'manual',
    description: manualHint(issue),
    safe: false,
  };
}

module.exports = { enrich };
