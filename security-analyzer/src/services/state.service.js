const fs = require('fs');
const path = require('path');
const { ANALYSIS_RETENTION_MS } = require('../config/constants');
const logger = require('../utils/logger');

// in-memory storing analyses + deleting them with temp repos
const analyses = new Map();
const cleanupTimers = new Map();

const aiFixes = new Map();

function put(analysisId, analysis) {
  analyses.set(analysisId, analysis);
  scheduleCleanup(analysisId);
}

function get(analysisId) {
  return analyses.get(analysisId) || null;
}

function list() {
  return Array.from(analyses.values());
}

function update(analysisId, updater) {
  const a = analyses.get(analysisId);
  if (!a) return null;
  updater(a);
  return a;
}

function findIssue(analysisId, issueId) {
  const a = analyses.get(analysisId);
  if (!a) return null;
  return (a.issues || []).find((i) => i.id === issueId) || null;
}

function markIssueStatus(analysisId, issueId, status) {
  const issue = findIssue(analysisId, issueId);
  if (!issue) return null;
  issue.status = status;
  return issue;
}

function remove(analysisId) {
  const a = analyses.get(analysisId);
  if (!a) return;
  analyses.delete(analysisId);
  const t = cleanupTimers.get(analysisId);
  if (t) { clearTimeout(t); cleanupTimers.delete(analysisId); }
  // Drop AI fixes that belong to this analysis.
  for (const [fixId, fix] of aiFixes) {
    if (fix.analysisId === analysisId) aiFixes.delete(fixId);
  }
  cleanupRepoPath(a.repoPath);
}

function putAiFix(fix) {
  if (!fix || !fix.fixId) return;
  aiFixes.set(fix.fixId, fix);
}

function getAiFix(fixId) {
  return aiFixes.get(fixId) || null;
}

function listAiFixesForIssue(analysisId, issueId) {
  const out = [];
  for (const f of aiFixes.values()) {
    if (f.analysisId === analysisId && f.issueId === issueId) out.push(f);
  }
  // newest first
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return out;
}

function cleanupRepoPath(repoPath) {
  if (!repoPath) return;
  // repoPath looks like <root>/<analysisId>/repo, need to delete the parent
  const parent = path.dirname(repoPath);
  fs.rm(parent, { recursive: true, force: true }, (err) => {
    if (err) logger.warn('Failed to clean repo dir', { dir: parent, err: err.message });
  });
}

function scheduleCleanup(analysisId) {
  const existing = cleanupTimers.get(analysisId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => remove(analysisId), ANALYSIS_RETENTION_MS);
  t.unref();
  cleanupTimers.set(analysisId, t);
}

function shutdown() {
  for (const id of analyses.keys()) {
    const a = analyses.get(id);
    cleanupRepoPath(a?.repoPath);
  }
  analyses.clear();
  for (const t of cleanupTimers.values()) clearTimeout(t);
  cleanupTimers.clear();
  aiFixes.clear();
}

module.exports = {
  put, get, list, update, findIssue, markIssueStatus, remove, shutdown,
  putAiFix, getAiFix, listAiFixesForIssue,
};
