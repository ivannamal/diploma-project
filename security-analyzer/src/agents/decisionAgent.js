const { countBySeverity } = require('../utils/severity');
/*
inputs:
- issues: every issue, with status open|ignored|fixed
- security: securityagent output
- build: buildtestagent output

output: { decision, risk_level, pipeline_status, reasons }

rules :
critical or high open issue - block
failed pipeline - block
timeout / skipped dynamic analysis - manual_review
medium severity issue still open - manual_review
otherwise - deploy

ignored or fixed issues drop out of the decision input.
*/
function decide({ issues, security, build }) {
  const active = (issues || []).filter((i) => i.status !== 'ignored' && i.status !== 'fixed');
  const counts = countBySeverity(active);

  let max = 'low';
  if (counts.critical > 0) max = 'critical';
  else if (counts.high > 0) max = 'high';
  else if (counts.medium > 0) max = 'medium';

  const pipeline = build?.pipeline_status || 'warning';
  const dynamicStatus = build?.summary?.status;
  const reasons = [];

  if (counts.critical > 0) reasons.push(`${counts.critical} critical issue${counts.critical === 1 ? '' : 's'} open.`);
  if (counts.high > 0) reasons.push(`${counts.high} high severity issue${counts.high === 1 ? '' : 's'} open.`);
  if (counts.medium > 0) reasons.push(`${counts.medium} medium severity issue${counts.medium === 1 ? '' : 's'} open.`);

  if (counts.critical > 0 || counts.high > 0) {
    return verdict('block', max, pipeline, reasons.length ? reasons : ['Critical or high severity issues are open.']);
  }

  if (pipeline === 'failed') {
    return verdict('block', max, pipeline, ['Build/test pipeline failed inside Docker.']);
  }

  if (dynamicStatus === 'timeout') {
    return verdict('manual_review', max, pipeline, ['Dynamic analysis timed out.']);
  }
  if (dynamicStatus === 'skipped') {
    return verdict('manual_review', max, pipeline, ['Dynamic analysis was skipped.']);
  }

  if (counts.medium > 0) {
    return verdict('manual_review', max, pipeline,
      reasons.length ? reasons : [`${counts.medium} medium severity issue(s) need review.`]);
  }

  return verdict('deploy', max, pipeline, ['No blocking issues; pipeline is stable.']);
}

function verdict(decision, risk_level, pipeline_status, reasons) {
  return { decision, risk_level, pipeline_status, reasons };
}

module.exports = { decide };
