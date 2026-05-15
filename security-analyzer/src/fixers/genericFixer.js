// fallback fix

async function apply({ analysis, issue }) {
  const hint = (issue.fix && issue.fix.description) || 'Manual remediation required.';
  const e = new Error(`Auto-fix is not available for "${issue.type}". ${hint}`);
  e.code = 'fix_not_safe';
  e.status = 400;
  throw e;
}

module.exports = { apply };
