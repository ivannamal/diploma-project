// dockerfile auto-fixes are intentionally disabled

async function apply({ analysis, issue }) {
  const e = new Error(
    'Dockerfile auto-fix is disabled. Pin the base image manually after verifying a safe version.'
  );
  e.code = 'fix_not_safe';
  e.status = 400;
  throw e;
}

module.exports = { apply };
