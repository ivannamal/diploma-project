// map the result status of build agent to its pipeline status + message
function evaluate(dynamicResult) {
  const status = dynamicResult?.summary?.status;
  const issueCount = (dynamicResult?.issues || []).length;
  let pipeline_status;
  let message;

  if (status === 'failed') {
    pipeline_status = 'failed';
    message = 'Build, tests or runtime checks failed inside Docker.';
  } else if (status === 'timeout') {
    pipeline_status = 'warning';
    message = 'Dynamic analysis timed out; treat as inconclusive and require manual review.';
  } else if (status === 'skipped') {
    pipeline_status = 'warning';
    message = 'Dynamic analysis was skipped; treat the pipeline state as unknown.';
  } else if (status === 'completed') {
    if (issueCount > 0) {
      pipeline_status = 'warning';
      message = 'Dynamic checks completed but produced non-blocking warnings.';
    } else {
      pipeline_status = 'stable';
      message = 'Dynamic build/test/start checks completed successfully inside Docker.';
    }
  } else {
    pipeline_status = 'warning';
    message = 'Pipeline state could not be determined.';
  }

  return {
    pipeline_status,
    summary: dynamicResult?.summary || { status: 'skipped' },
    message,
    message_for_next_agent: message,
  };
}

module.exports = { evaluate };
