// package.json auto-fixes are intentionally disabled

async function apply({ analysis, issue }) {
  const e = new Error(
    'package.json auto-fix is disabled. Review and remediate the script manually.'
  );
  e.code = 'fix_not_safe';
  e.status = 400;
  throw e;
}

module.exports = { apply };
