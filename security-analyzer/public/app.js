(() => {
  'use strict';

  const els = {
    repoUrl: document.getElementById('repoUrl'),
    analyzeBtn: document.getElementById('analyzeBtn'),
    analyzeOpenaiBtn: document.getElementById('analyzeOpenaiBtn'),
    resetBtn: document.getElementById('resetBtn'),
    progress: document.getElementById('progress'),
    progressText: document.getElementById('progressText'),
    errorBox: document.getElementById('errorBox'),
    modeLabel: document.getElementById('modeLabel'),

    openaiSection: document.getElementById('openaiSection'),
    openaiModel: document.getElementById('openaiModel'),
    openaiError: document.getElementById('openaiError'),
    openaiSecurity: document.getElementById('openaiSecurity'),
    openaiBuild: document.getElementById('openaiBuild'),
    openaiDecision: document.getElementById('openaiDecision'),

    summary: document.getElementById('summary'),
    sumDecision: document.getElementById('sumDecision'),
    sumDecisionReason: document.getElementById('sumDecisionReason'),
    sumRisk: document.getElementById('sumRisk'),
    sumFiles: document.getElementById('sumFiles'),
    sumIssues: document.getElementById('sumIssues'),
    sumFixable: document.getElementById('sumFixable'),
    sumDynamic: document.getElementById('sumDynamic'),

    agentsSection: document.getElementById('agentsSection'),
    agentSecurity: document.getElementById('agentSecurity'),
    agentBuild: document.getElementById('agentBuild'),
    agentDecision: document.getElementById('agentDecision'),

    issuesSection: document.getElementById('issuesSection'),
    issuesContainer: document.getElementById('issuesContainer'),

    diffSection: document.getElementById('diffSection'),
    diffMeta: document.getElementById('diffMeta'),
    diffViewer: document.getElementById('diffViewer'),

    rawSection: document.getElementById('rawSection'),
    rawJson: document.getElementById('rawJson'),

    issueTpl: document.getElementById('issueTemplate'),

    watchBtn: document.getElementById('watchBtn'),
    watchStatus: document.getElementById('watchStatus'),
    watchList: document.getElementById('watchList'),
    checkNowBtn: document.getElementById('checkNowBtn'),
    pollStatus: document.getElementById('pollStatus'),

    refreshRecentBtn: document.getElementById('refreshRecentBtn'),
    recentStatus: document.getElementById('recentStatus'),
    recentList: document.getElementById('recentList'),
  };

  const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/i;

  const state = {
    analysis: null,
  };

  const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

  function api(path, opts = {}) {
    return fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.message || data.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = data.error;
        throw err;
      }
      return data;
    });
  }

  function showError(msg) {
    els.errorBox.textContent = msg;
    els.errorBox.hidden = false;
  }
  function clearError() {
    els.errorBox.hidden = true;
    els.errorBox.textContent = '';
  }

  function setBusy(busy, text) {
    els.analyzeBtn.disabled = busy;
    if (els.analyzeOpenaiBtn) els.analyzeOpenaiBtn.disabled = busy;
    if (busy) {
      els.progress.hidden = false;
      if (text) els.progressText.textContent = text;
    } else {
      els.progress.hidden = true;
    }
  }

  function setModeLabel(mode) {
    if (!els.modeLabel) return;
    if (!mode) { els.modeLabel.hidden = true; els.modeLabel.textContent = ''; return; }
    els.modeLabel.hidden = false;
    let text;
    if (mode === 'openai') text = 'Analysis mode: OpenAI agent analysis';
    else if (mode === 'local') text = 'Analysis mode: Local analyzer';
    else text = `Analysis mode: ${mode}`;
    els.modeLabel.textContent = text;
  }

  function render(analysis) {
    state.analysis = analysis;
    els.summary.hidden = false;
    els.agentsSection.hidden = false;
    els.issuesSection.hidden = false;
    els.rawSection.hidden = false;
    els.resetBtn.hidden = false;
    renderSummary(analysis.summary, analysis.agents);
    renderAgents(analysis.agents);
    renderIssues(analysis.issues || []);
    els.rawJson.textContent = JSON.stringify(analysis, null, 2);
  }

  function renderSummary(summary, agents) {
    const dec = summary.decision || 'manual_review';
    els.sumDecision.textContent = decisionLabel(dec);
    els.sumDecision.className = 'value ' + decisionClass(dec);
    els.sumDecisionReason.textContent = (agents?.decision?.reasons || []).join(' ');

    const risk = summary.risk_level || 'low';
    els.sumRisk.textContent = risk.toUpperCase();
    els.sumRisk.className = 'value risk-' + risk;

    els.sumFiles.textContent = summary.checkedFiles ?? '—';
    els.sumIssues.textContent = summary.issueCount ?? 0;
    els.sumFixable.textContent = summary.fixableIssueCount ?? 0;
    els.sumDynamic.textContent = (summary.dynamicStatus || 'unknown').toUpperCase();
  }

  function renderAgents(agents) {
    const sec = agents?.security || {};
    const counts = sec.counts || { critical: 0, high: 0, medium: 0, low: 0 };
    els.agentSecurity.innerHTML = `
      <div class="agent-status-line">
        <strong>Status:</strong> ${escapeHtml(sec.security_status || 'unknown')}
        &nbsp;·&nbsp;
        <strong>Risk:</strong> ${escapeHtml(sec.risk_level || 'unknown')}
      </div>
      <div class="agent-status-line">
        <strong>Findings:</strong>
        critical=${counts.critical}, high=${counts.high},
        medium=${counts.medium}, low=${counts.low}
      </div>
      <div>${escapeHtml(sec.message || '')}</div>
    `;

    const build = agents?.buildTest || {};
    const summary = build.summary || {};
    els.agentBuild.innerHTML = `
      <div class="agent-status-line">
        <strong>Pipeline:</strong> ${escapeHtml(build.pipeline_status || 'unknown')}
      </div>
      <div class="agent-status-line">
        <strong>Dynamic status:</strong> ${escapeHtml(summary.status || 'unknown')}
        ${summary.kind ? '· kind=' + escapeHtml(summary.kind) : ''}
        ${summary.healthPort ? '· port=' + summary.healthPort : ''}
      </div>
      <div>${escapeHtml(build.message || '')}</div>
    `;

    const dec = agents?.decision || {};
    els.agentDecision.innerHTML = `
      <div class="agent-status-line">
        <strong>Decision:</strong>
        <span class="${decisionClass(dec.decision)}">${escapeHtml(decisionLabel(dec.decision || 'unknown'))}</span>
      </div>
      <div class="agent-status-line">
        <strong>Risk level:</strong>
        <span class="risk-${escapeHtml(dec.risk_level || 'low')}">${escapeHtml((dec.risk_level || 'unknown').toUpperCase())}</span>
      </div>
      ${(dec.reasons && dec.reasons.length)
        ? `<ul class="agent-reasons">${dec.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        : ''}
    `;
  }

  function renderIssues(issues) {
    const sorted = issues.slice().sort((a, b) => {
      const sa = SEVERITY_ORDER[a.severity] ?? 9;
      const sb = SEVERITY_ORDER[b.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      return (a.file || '').localeCompare(b.file || '');
    });

    els.issuesContainer.innerHTML = '';
    if (sorted.length === 0) {
      els.issuesContainer.innerHTML = `<p class="muted">No issues detected.</p>`;
      return;
    }

    const groups = { critical: [], high: [], medium: [], low: [] };
    for (const i of sorted) (groups[i.severity] || groups.low).push(i);

    for (const sev of ['critical', 'high', 'medium', 'low']) {
      const g = groups[sev];
      if (!g.length) continue;
      const heading = document.createElement('h3');
      heading.className = 'severity-group';
      heading.textContent = `${sev.toUpperCase()} (${g.length})`;
      els.issuesContainer.appendChild(heading);
      for (const issue of g) els.issuesContainer.appendChild(buildIssueCard(issue));
    }
  }

  function buildIssueCard(issue) {
    const node = els.issueTpl.content.firstElementChild.cloneNode(true);
    node.dataset.issueId = issue.id;

    const sev = node.querySelector('.badge.severity');
    sev.textContent = issue.severity;
    sev.classList.add(issue.severity);

    const status = node.querySelector('.badge.status');
    status.textContent = issue.status;
    status.classList.add(issue.status);

    const source = node.querySelector('.badge.source');
    source.textContent = issue.source;
    source.classList.add(issue.source);

    node.querySelector('.issue-type').textContent = issue.type;

    const fileLine = node.querySelector('.issue-file');
    if (issue.file) {
      fileLine.textContent = issue.file + (issue.line ? `:${issue.line}` : '');
    } else {
      fileLine.textContent = '(repository-wide)';
    }

    node.querySelector('.issue-message').textContent = issue.message || '';
    const rec = node.querySelector('.issue-recommendation');
    rec.textContent = issue.recommendation || '';

    const detailsBox = node.querySelector('.issue-details');
    if (issue.details && typeof issue.details === 'object') {
      detailsBox.innerHTML = renderDetails(issue.details) +
        `<details class="raw-details"><summary>Raw issue JSON</summary><pre class="diff">${escapeHtml(JSON.stringify(issue, null, 2))}</pre></details>`;
    } else {
      detailsBox.textContent = JSON.stringify(issue, null, 2);
    }

    const detailsBtn = node.querySelector('.details-btn');
    detailsBtn.addEventListener('click', () => {
      detailsBox.hidden = !detailsBox.hidden;
      detailsBtn.textContent = detailsBox.hidden ? 'View details' : 'Hide details';
    });

    const fixBtn = node.querySelector('.fix-btn');
    const ignoreBtn = node.querySelector('.ignore-btn');

    const canFix = !!(issue.fix && issue.fix.available && issue.fix.safe);
    if (!canFix) {
      fixBtn.disabled = true;
      fixBtn.textContent = 'Manual fix required';
      fixBtn.title = (issue.fix && issue.fix.description) || 'Auto-fix is not available for this issue.';
    }

    if (issue.status === 'fixed') {
      fixBtn.disabled = true;
      fixBtn.textContent = 'Fixed';
      ignoreBtn.disabled = true;
      node.classList.add('dimmed');
    }
    if (issue.status === 'ignored') {
      fixBtn.disabled = true;
      ignoreBtn.disabled = true;
      ignoreBtn.textContent = 'Ignored';
      node.classList.add('dimmed');
    }

    fixBtn.addEventListener('click', () => onApplyFix(issue));
    ignoreBtn.addEventListener('click', () => onIgnore(issue));

    const aiBtn = node.querySelector('.ai-fix-btn');
    const aiPanel = node.querySelector('.ai-fix-panel');
    if (aiBtn && !canFix && issue.status === 'open') {
      aiBtn.hidden = false;
      aiBtn.addEventListener('click', () => onGenerateAiFix(issue, aiBtn, aiPanel));
    }

    return node;
  }

  async function onGenerateAiFix(issue, btn, panel) {
    if (!state.analysis || !panel) return;
    clearError();
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating...';
    panel.hidden = false;
    panel.innerHTML = `
      <div class="ai-fix-status ai-fix-loading">
        <span class="spinner"></span>
        <span>Generating and verifying fix (this may take a few minutes)...</span>
      </div>`;
    try {
      const result = await api(`/api/issues/${encodeURIComponent(issue.id)}/generate-ai-fix`, {
        method: 'POST',
        body: JSON.stringify({ analysisId: state.analysis.analysisId }),
      });
      renderAiFixResult(result, panel);
    } catch (err) {
      panel.innerHTML = `<div class="ai-fix-status ai-fix-error">AI fix failed: ${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  function renderAiFixResult(result, panel) {
    if (!result) {
      panel.innerHTML = '<div class="ai-fix-status ai-fix-error">No AI fix result.</div>';
      return;
    }
    if (result.verified && result.available) {
      panel.innerHTML = `
        <div class="ai-fix-status ai-fix-passed">
          <strong>Verified AI fix</strong>
          <span class="badge confidence-${escapeHtml(result.confidence || 'low')}">${escapeHtml((result.confidence || 'low').toUpperCase())}</span>
        </div>
        <div class="ai-fix-explanation">${escapeHtml(result.description || '')}</div>
        ${renderList('Changed files', (result.changedFiles || []).map((f) => `<code>${escapeHtml(f)}</code>`))}
        ${renderList('Verification plan', result.verification_plan || [])}
        ${renderList('Risk notes', result.risk_notes || [])}
        ${result.diff
          ? `<details class="ai-fix-diff-block" open><summary>Diff preview</summary><pre class="diff">${formatDiff(result.diff)}</pre></details>`
          : ''}
        <div class="ai-fix-actions">
          <button class="btn small primary apply-ai-fix-btn">Apply verified fix</button>
        </div>`;
      const applyBtn = panel.querySelector('.apply-ai-fix-btn');
      applyBtn.addEventListener('click', () => onApplyAiFix(result, applyBtn, panel));
      return;
    }
    const reason = result.reason || 'All generated fixes failed verification.';
    const attemptCount = Array.isArray(result.attempts) ? result.attempts.length : 0;
    panel.innerHTML = `
      <div class="ai-fix-status ai-fix-failed">
        AI could not generate a verified safe fix for this issue.
      </div>
      <div class="ai-fix-explanation muted">${escapeHtml(reason)}</div>
      ${attemptCount > 0
        ? `<div class="ai-fix-list-label muted small">Attempts: ${attemptCount}</div>
           <ul class="ai-fix-attempt-list">${result.attempts.map((a) => `
             <li>
               <span class="muted small">#${escapeHtml(String(a.attempt))}</span>
               <span class="badge attempt-${escapeHtml(a.status)}">${escapeHtml(a.status)}</span>
               ${a.reason ? `<span class="muted small">${escapeHtml(a.reason)}</span>` : ''}
             </li>`).join('')}</ul>`
        : ''}`;
  }

  function renderList(label, items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    return `
      <div class="ai-fix-list">
        <div class="ai-fix-list-label">${escapeHtml(label)}</div>
        <ul>${items.map((s) => `<li>${typeof s === 'string' ? escapeHtml(s) : s}</li>`).join('')}</ul>
      </div>`;
  }

  async function onApplyAiFix(fix, btn, panel) {
    if (!state.analysis) return;
    btn.disabled = true;
    btn.textContent = 'Applying...';
    try {
      const result = await api(`/api/fixes/${encodeURIComponent(fix.fixId)}/apply`, {
        method: 'POST',
      });
      const fresh = await api(`/api/analyses/${encodeURIComponent(state.analysis.analysisId)}`);
      render(fresh);
      showDiff(result);
      panel.querySelector('.ai-fix-status').className = 'ai-fix-status ai-fix-applied';
      panel.querySelector('.ai-fix-status').innerHTML = '<strong>AI fix applied to temporary repository copy.</strong>';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Apply verified fix';
      showError(`Apply verified fix failed: ${err.message}`);
    }
  }

  async function onApplyFix(issue) {
    if (!state.analysis) return;
    clearError();
    try {
      const result = await api(`/api/issues/${encodeURIComponent(issue.id)}/apply-fix`, {
        method: 'POST',
        body: JSON.stringify({ analysisId: state.analysis.analysisId }),
      });
      // refresh full analysis state from the server (authoritative)
      const fresh = await api(`/api/analyses/${encodeURIComponent(state.analysis.analysisId)}`);
      render(fresh);
      showDiff(result);
    } catch (err) {
      showError(`Apply fix failed: ${err.message}`);
    }
  }

  async function onIgnore(issue) {
    if (!state.analysis) return;
    clearError();
    try {
      await api(`/api/issues/${encodeURIComponent(issue.id)}/ignore`, {
        method: 'POST',
        body: JSON.stringify({ analysisId: state.analysis.analysisId }),
      });
      const fresh = await api(`/api/analyses/${encodeURIComponent(state.analysis.analysisId)}`);
      render(fresh);
    } catch (err) {
      showError(`Ignore failed: ${err.message}`);
    }
  }

  function showDiff(result) {
    els.diffSection.hidden = false;
    els.diffMeta.textContent =
      `Issue ${result.issueId} · status: ${result.status} · changed: ${(result.changedFiles || []).join(', ') || '(none)'}`;
    els.diffViewer.innerHTML = formatDiff(result.diff || '(no diff)');
    els.diffSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function formatDiff(diff) {
    return diff.split('\n').map((line) => {
      const safe = escapeHtml(line);
      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        return `<span class="diff-line-meta">${safe}</span>`;
      }
      if (line.startsWith('+')) return `<span class="diff-line-added">${safe}</span>`;
      if (line.startsWith('-')) return `<span class="diff-line-removed">${safe}</span>`;
      return safe;
    }).join('\n');
  }

  function decisionLabel(d) {
    if (d === 'deploy') return 'DEPLOY';
    if (d === 'manual_review') return 'MANUAL REVIEW';
    if (d === 'block') return 'BLOCK';
    return (d || 'unknown').toUpperCase();
  }
  function decisionClass(d) {
    if (d === 'deploy') return 'decision-deploy';
    if (d === 'manual_review') return 'decision-manual';
    if (d === 'block') return 'decision-block';
    return '';
  }

  function renderDetails(d) {
    const rows = [];
    const addRow = (label, value) => {
      if (value === undefined || value === null || value === '' ||
          (Array.isArray(value) && value.length === 0)) return;
      rows.push(`
        <div class="detail-row">
          <div class="detail-label">${escapeHtml(label)}</div>
          <div class="detail-value">${value}</div>
        </div>`);
    };

    addRow('Last stage', d.lastStage ? `<code>${escapeHtml(d.lastStage)}</code>` : null);
    addRow('Failed stage', d.failedStage ? `<code>${escapeHtml(d.failedStage)}</code>` : null);
    if (Array.isArray(d.completedStages) && d.completedStages.length > 0) {
      addRow('Completed stages', d.completedStages.map((s) =>
        `<code>${escapeHtml(s)}</code>`).join(' &rarr; '));
    }
    addRow('Install command', d.installCommand ? `<code>${escapeHtml(d.installCommand)}</code>` : null);
    addRow('Install elapsed', d.installElapsedMs != null ? formatMs(d.installElapsedMs) : null);
    addRow('Total elapsed', d.totalElapsedMs != null ? formatMs(d.totalElapsedMs) : null);
    addRow('Exit code', d.exitCode != null ? String(d.exitCode) : null);
    addRow('Timed out', d.timedOut ? 'yes' : null);
    addRow('Likely cause', d.likelyInstallCause ? escapeHtml(d.likelyInstallCause) : null);
    addRow('Last npm activity', d.lastNpmActivity
      ? `<code>${escapeHtml(d.lastNpmActivity)}</code>` : null);

    if (Array.isArray(d.recentNpmFetches) && d.recentNpmFetches.length > 0) {
      addRow('Recent npm fetches',
        d.recentNpmFetches.map((p) => `<code>${escapeHtml(p)}</code>`).join(', '));
    }
    if (Array.isArray(d.recentNpmErrors) && d.recentNpmErrors.length > 0) {
      addRow('Recent npm errors',
        `<pre class="diff small-pre">${d.recentNpmErrors.map(escapeHtml).join('\n')}</pre>`);
    }
    if (Array.isArray(d.recentNpmTimings) && d.recentNpmTimings.length > 0) {
      addRow('Recent npm timings',
        `<details><summary>${d.recentNpmTimings.length} lines</summary><pre class="diff small-pre">${d.recentNpmTimings.map(escapeHtml).join('\n')}</pre></details>`);
    }

    let html = `<div class="details-grid">${rows.join('')}</div>`;

    if (d.stdoutTail) {
      html += `<details class="log-block"><summary>stdout tail (${d.stdoutTail.length} chars)</summary><pre class="diff">${escapeHtml(d.stdoutTail)}</pre></details>`;
    }
    if (d.stderrTail) {
      html += `<details class="log-block"><summary>stderr tail (${d.stderrTail.length} chars)</summary><pre class="diff">${escapeHtml(d.stderrTail)}</pre></details>`;
    }
    return html;
  }

  function formatMs(ms) {
    if (ms === null || ms === undefined) return '—';
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    const pretty = m > 0 ? `${m}m ${s}s` : `${s}s`;
    return `${pretty} <span class="muted small">(${ms} ms)</span>`;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function resetView() {
    state.analysis = null;
    els.summary.hidden = true;
    els.agentsSection.hidden = true;
    els.issuesSection.hidden = true;
    els.diffSection.hidden = true;
    els.rawSection.hidden = true;
    els.resetBtn.hidden = true;
    if (els.openaiSection) els.openaiSection.hidden = true;
    if (els.openaiError) { els.openaiError.hidden = true; els.openaiError.textContent = ''; }
    els.issuesContainer.innerHTML = '';
    clearError();
  }

  async function performAnalyze(mode) {
    const url = (els.repoUrl.value || '').trim();
    clearError();
    if (!url) {
      showError('Please enter a GitHub repository URL.');
      return;
    }
    resetView();
    setModeLabel(mode);
    const progressMsg = mode === 'openai'
      ? 'Running OpenAI agent analysis (local pipeline + OpenAI call)...'
      : 'Running local analysis (clone, static scan, dynamic Docker build)...';
    setBusy(true, progressMsg);
    try {
      if (mode === 'openai') {
        const result = await api('/api/analyze/openai', {
          method: 'POST',
          body: JSON.stringify({ repoUrl: url }),
        });
        if (result.local_result) render(result.local_result);
        renderOpenai(result.openai_result, result.openai_error);
      } else {
        const analysis = await api('/api/analyze', {
          method: 'POST',
          body: JSON.stringify({ repoUrl: url }),
        });
        render(analysis);
        hideOpenai();
      }
      refreshRecentAnalyses();
    } catch (err) {
      showError(`Analysis failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function hideOpenai() {
    if (els.openaiSection) els.openaiSection.hidden = true;
    if (els.openaiError) { els.openaiError.hidden = true; els.openaiError.textContent = ''; }
  }

  function renderOpenai(result, error) {
    if (!els.openaiSection) return;
    els.openaiSection.hidden = false;

    if (error) {
      els.openaiError.hidden = false;
      els.openaiError.textContent = `OpenAI agent analysis failed: ${error}`;
    } else {
      els.openaiError.hidden = true;
      els.openaiError.textContent = '';
    }

    if (!result || !result.agent_analysis) {
      els.openaiModel.textContent = '';
      els.openaiSecurity.innerHTML = '<span class="muted">No data.</span>';
      els.openaiBuild.innerHTML = '<span class="muted">No data.</span>';
      els.openaiDecision.innerHTML = '<span class="muted">No data.</span>';
      return;
    }

    els.openaiModel.textContent = result.model ? `model: ${result.model}` : '';
    const aa = result.agent_analysis;
    els.openaiSecurity.innerHTML = renderOpenaiSecurity(aa.security_agent);
    els.openaiBuild.innerHTML = renderOpenaiBuild(aa.build_test_agent);
    els.openaiDecision.innerHTML = renderOpenaiDecision(aa.decision_agent);
  }

  function renderOpenaiSecurity(s) {
    s = s || {};
    return `
      <div class="agent-status-line">
        <strong>Status:</strong> ${escapeHtml(s.status || '—')}
        &nbsp;·&nbsp;
        <strong>Risk:</strong>
        <span class="risk-${escapeHtml(s.risk_level || 'low')}">${escapeHtml((s.risk_level || '—').toUpperCase())}</span>
      </div>
      <div>${escapeHtml(s.summary || '')}</div>
      ${renderFindings(s.findings)}
    `;
  }

  function renderOpenaiBuild(b) {
    b = b || {};
    return `
      <div class="agent-status-line">
        <strong>Status:</strong> ${escapeHtml(b.status || '—')}
      </div>
      <div>${escapeHtml(b.summary || '')}</div>
      ${renderFindings(b.findings)}
    `;
  }

  function renderOpenaiDecision(d) {
    d = d || {};
    const decision = d.decision || 'manual_review';
    return `
      <div class="agent-status-line">
        <strong>Decision:</strong>
        <span class="value big-decision ${decisionClass(decision)}">${escapeHtml(decisionLabel(decision))}</span>
      </div>
      <div class="agent-status-line">
        <strong>Risk level:</strong>
        <span class="risk-${escapeHtml(d.risk_level || 'low')}">${escapeHtml((d.risk_level || '—').toUpperCase())}</span>
      </div>
      <div class="agent-status-line"><strong>Reason:</strong> ${escapeHtml(d.reason || '')}</div>
      ${renderRequiredActions(d.required_actions)}
    `;
  }

  function renderFindings(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return `<ul class="agent-reasons">${list.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`;
  }

  function renderRequiredActions(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return `
      <div class="agent-status-line"><strong>Required actions:</strong></div>
      <ul class="agent-reasons">${list.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
    `;
  }

  els.analyzeBtn.addEventListener('click', () => performAnalyze('local'));
  if (els.analyzeOpenaiBtn) {
    els.analyzeOpenaiBtn.addEventListener('click', () => performAnalyze('openai'));
  }

  els.resetBtn.addEventListener('click', () => {
    resetView();
    setModeLabel(null);
    hideOpenai();
  });

  els.repoUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.analyzeBtn.click();
  });

  async function watchRepository() {
    const url = (els.repoUrl.value || '').trim();
    if (!url || !GITHUB_URL_RE.test(url)) {
      setWatchStatus('Please enter a valid GitHub repository URL.', 'error');
      return;
    }
    setWatchBusy(true, 'Adding...');
    try {
      const result = await api('/api/watch', {
        method: 'POST',
        body: JSON.stringify({ repository: url }),
      });
      if (result.alreadyExists) {
        setWatchStatus('Repository is already being watched.', 'info');
      } else {
        setWatchStatus('Repository is now being watched for pull requests.', 'success');
      }
      await refreshWatchList();
    } catch (err) {
      if (/invalid/i.test(err.message)) {
        setWatchStatus('Please enter a valid GitHub repository URL.', 'error');
      } else {
        setWatchStatus(`Watch failed: ${err.message}`, 'error');
      }
    } finally {
      setWatchBusy(false);
    }
  }

  async function unwatchRepository(owner, repo, btn) {
    if (btn) btn.disabled = true;
    try {
      await api(
        `/api/watch/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: 'DELETE' }
      );
      setWatchStatus(`${owner}/${repo} removed from the watch list.`, 'info');
      await refreshWatchList();
    } catch (err) {
      setWatchStatus(`Unwatch failed: ${err.message}`, 'error');
      if (btn) btn.disabled = false;
    }
  }

  async function refreshWatchList() {
    if (!els.watchList) return;
    try {
      const result = await api('/api/watch');
      renderWatchList(result.watched || []);
    } catch (err) {
      setWatchStatus(`Could not load watch list: ${err.message}`, 'error');
    }
  }

  function renderWatchList(items) {
    els.watchList.innerHTML = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'watch-empty muted small';
      li.textContent = 'No repositories are being watched yet.';
      els.watchList.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'watch-item';

      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.fullName;
      li.appendChild(link);

      const since = document.createElement('span');
      since.className = 'muted small';
      since.textContent = item.addedAt
        ? `added ${new Date(item.addedAt).toLocaleString()}`
        : '';
      li.appendChild(since);

      const btn = document.createElement('button');
      btn.className = 'btn small secondary';
      btn.textContent = 'Unwatch';
      btn.addEventListener('click', () => unwatchRepository(item.owner, item.repo, btn));
      li.appendChild(btn);

      els.watchList.appendChild(li);
    }
  }

  function setWatchBusy(busy, label) {
    if (!els.watchBtn) return;
    els.watchBtn.disabled = busy;
    els.watchBtn.textContent = busy ? (label || 'Working...') : 'Watch repository';
  }

  function setWatchStatus(text, kind) {
    if (!els.watchStatus) return;
    els.watchStatus.textContent = text || '';
    els.watchStatus.className = 'watch-status small ' + (kind ? 'watch-' + kind : '');
    if (text) {
      clearTimeout(els.watchStatus._timer);
      els.watchStatus._timer = setTimeout(() => {
        els.watchStatus.textContent = '';
        els.watchStatus.className = 'watch-status small';
      }, 6000);
    }
  }

  if (els.watchBtn) {
    els.watchBtn.addEventListener('click', watchRepository);
  }

  async function checkPullRequestsNow() {
    if (!els.checkNowBtn) return;
    setCheckBusy(true);
    setPollStatus('Checking pull requests on GitHub...', 'info');
    try {
      const result = await api('/api/watch/check-now', { method: 'POST' });
      if (!result.ok) {
        setPollStatus(result.message || 'Check is already running.', 'info');
        return;
      }
      const parts = [
        `Checked ${result.pullRequestsChecked} pull request${result.pullRequestsChecked === 1 ? '' : 's'}`,
        `across ${result.repositoriesChecked} repositor${result.repositoriesChecked === 1 ? 'y' : 'ies'}`,
        `· scheduled ${result.analysesScheduled} analys${result.analysesScheduled === 1 ? 'is' : 'es'}`,
      ];
      if (result.errorCount) parts.push(`· ${result.errorCount} fetch error${result.errorCount === 1 ? '' : 's'}`);
      const kind = result.errorCount ? 'error' : (result.analysesScheduled ? 'success' : 'info');
      setPollStatus(parts.join(' '), kind);
      if (result.analysesScheduled > 0) {
        setTimeout(refreshRecentAnalyses, 4000);
      }
    } catch (err) {
      setPollStatus(`Check failed: ${err.message}`, 'error');
    } finally {
      setCheckBusy(false);
    }
  }

  function setCheckBusy(busy) {
    if (!els.checkNowBtn) return;
    els.checkNowBtn.disabled = busy;
    els.checkNowBtn.textContent = busy ? 'Checking...' : 'Check pull requests now';
  }

  function setPollStatus(text, kind) {
    if (!els.pollStatus) return;
    els.pollStatus.textContent = text || '';
    els.pollStatus.className = 'poll-status small ' + (kind ? 'poll-' + kind : '');
  }

  if (els.checkNowBtn) {
    els.checkNowBtn.addEventListener('click', checkPullRequestsNow);
  }

  async function refreshRecentAnalyses() {
    if (!els.recentList) return;
    try {
      const result = await api('/api/analyses');
      renderRecentAnalyses(result.analyses || []);
      setRecentStatus('', null);
    } catch (err) {
      setRecentStatus(`Could not load analyses: ${err.message}`, 'error');
    }
  }

  function renderRecentAnalyses(items) {
    els.recentList.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'recent-empty muted small';
      li.textContent = 'No analyses yet. Run one manually, or click "Check pull requests now".';
      els.recentList.appendChild(li);
      return;
    }
    for (const item of items) {
      els.recentList.appendChild(buildRecentItem(item));
    }
  }

  function buildRecentItem(item) {
    const li = document.createElement('li');
    li.className = 'recent-item';

    const head = document.createElement('div');
    head.className = 'recent-head';

    const repo = document.createElement('span');
    repo.className = 'recent-repo';
    repo.textContent = item.repository || item.analysisId;
    head.appendChild(repo);

    if (item.pullRequestNumber != null) {
      const prBadge = item.pullRequestUrl
        ? document.createElement('a')
        : document.createElement('span');
      prBadge.className = 'badge pr-badge';
      prBadge.textContent = `PR #${item.pullRequestNumber}`;
      if (item.pullRequestUrl) {
        prBadge.href = item.pullRequestUrl;
        prBadge.target = '_blank';
        prBadge.rel = 'noopener noreferrer';
      }
      head.appendChild(prBadge);
    }

    if (item.trigger && item.trigger !== 'manual') {
      const trig = document.createElement('span');
      trig.className = 'badge trigger-badge';
      trig.textContent = item.trigger.replace(/_/g, ' ');
      head.appendChild(trig);
    }

    const dec = document.createElement('span');
    dec.className = 'badge decision-badge ' + decisionClass(item.decision);
    dec.textContent = decisionLabel(item.decision || 'manual_review');
    head.appendChild(dec);

    li.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'recent-meta muted small';
    const parts = [];
    parts.push(`${item.issueCount || 0} issue${item.issueCount === 1 ? '' : 's'}`);
    if (item.fixableIssueCount) parts.push(`${item.fixableIssueCount} fixable`);
    if (item.dynamicStatus) parts.push(`dynamic: ${item.dynamicStatus}`);
    if (item.risk_level) parts.push(`risk: ${item.risk_level}`);
    if (item.created_at) parts.push(new Date(item.created_at).toLocaleString());
    meta.textContent = parts.join(' · ');
    li.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'recent-actions';
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.textContent = 'View report';
    btn.addEventListener('click', () => viewStoredReport(item));
    actions.appendChild(btn);
    li.appendChild(actions);

    return li;
  }

  async function viewStoredReport(item) {
    if (!item || !item.analysisId) return;
    resetView();
    hideOpenai();
    setBusy(true, 'Loading stored report...');
    try {
      const analysis = await api(`/api/analyses/${encodeURIComponent(item.analysisId)}`);
      render(analysis);
      setModeLabel(analysis.trigger && analysis.trigger !== 'manual'
        ? `stored · trigger: ${analysis.trigger.replace(/_/g, ' ')}`
        : 'local');
      els.summary?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError(`Failed to load report: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  function setRecentStatus(text, kind) {
    if (!els.recentStatus) return;
    els.recentStatus.textContent = text || '';
    els.recentStatus.className = 'recent-status small ' + (kind ? 'recent-' + kind : '');
  }

  if (els.refreshRecentBtn) {
    els.refreshRecentBtn.addEventListener('click', refreshRecentAnalyses);
  }
  refreshWatchList();
  refreshRecentAnalyses();
})();
