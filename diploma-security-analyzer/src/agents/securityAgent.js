const { countBySeverity } = require('../utils/severity');

// map the count of issues from static agent to its status + message
function evaluate(staticIssues) {
  const counts = countBySeverity(staticIssues || []);

  let security_status = 'ok';
  if (counts.critical > 0 || counts.high > 0) security_status = 'critical';
  else if (counts.medium > 0 || counts.low > 0) security_status = 'warning';

  let risk_level = 'low';
  if (counts.critical > 0) risk_level = 'critical';
  else if (counts.high > 0) risk_level = 'high';
  else if (counts.medium > 0) risk_level = 'medium';

  let message;
  if (security_status === 'ok') {
    message = 'No security findings in static analysis.';
  } else if (security_status === 'warning') {
    message = `Static analysis found ${counts.medium + counts.low} low/medium severity findings; review recommended.`;
  } else {
    message = `Static analysis found ${counts.critical} critical and ${counts.high} high severity findings; must be reviewed before deployment.`;
  }

  return {
    security_status,
    risk_level,
    counts,
    message,
    message_for_next_agent: message,
  };
}

module.exports = { evaluate };
