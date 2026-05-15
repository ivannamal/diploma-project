// pulls the github rest api every WATCH_POLL_INTERVAL_MS (2 min)
// for every repository in the watch list, finds open pull requests that
// are new or whose head.sha has changed since the last check, and runs
// the standard local analysis pipeline for each of them
//
// seen PRs are tracked in-memory:
//   key = "owner/repo#<prNumber>"
//   value = headSha last analyzed

const watchService = require('./watch.service');
const analysisService = require('./analysis.service');
const logger = require('../utils/logger');

const POLL_INTERVAL_MS = parseInt(process.env.WATCH_POLL_INTERVAL_MS, 10) || 120_000;
const FIRST_RUN_DELAY_MS = 10_000;
const GITHUB_API = 'https://api.github.com';
const GITHUB_FETCH_TIMEOUT_MS = 30_000;

// "owner/repo#N" -> headSha
const seenPRs = new Map();

let pollTimer = null;
let firstRunTimer = null;
let inFlight = false;
let lastCheckAt = null;
let lastResult = null;

function authHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'security-analyzer',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function fetchOpenPullRequests(owner, repo) {
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`GitHub API ${res.status}: ${(text || 'no body').slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`GitHub API request timed out after ${GITHUB_FETCH_TIMEOUT_MS} ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function checkRepository(entry) {
  const result = {
    fullName: entry.fullName,
    pullRequestsSeen: 0,
    analysesScheduled: 0,
    error: null,
  };
  let prs;
  try {
    prs = await fetchOpenPullRequests(entry.owner, entry.repo);
  } catch (err) {
    logger.warn('Polling fetch failed', { fullName: entry.fullName, error: err.message });
    result.error = err.message;
    return result;
  }
  if (!Array.isArray(prs)) {
    result.error = 'GitHub API returned an unexpected payload.';
    return result;
  }

  for (const pr of prs) {
    if (!pr || typeof pr !== 'object') continue;
    result.pullRequestsSeen++;
    const headSha = pr.head?.sha;
    if (!headSha || typeof pr.number !== 'number') continue;

    const key = `${entry.fullName}#${pr.number}`;
    const lastSha = seenPRs.get(key);
    if (lastSha === headSha) continue;

    seenPRs.set(key, headSha);
    result.analysesScheduled++;

    const cloneUrl =
      pr.head?.repo?.clone_url ||
      `https://github.com/${entry.fullName}.git`;

    const ctx = {
      trigger: 'github_pull_request_polling',
      repository: entry.fullName,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.html_url || null,
      headSha,
      headRef: pr.head?.ref || null,
      baseRef: pr.base?.ref || null,
    };

    logger.info('PR analysis scheduled (polling)', { ...ctx });
    setImmediate(() => runBackgroundAnalysis(cloneUrl, ctx));
  }
  return result;
}

async function runBackgroundAnalysis(cloneUrl, ctx) {
  logger.info('PR analysis started (polling)', { ...ctx });
  try {
    const analysis = await analysisService.analyzeRepository(cloneUrl, ctx);
    logger.info('PR analysis completed (polling)', {
      analysisId: analysis.analysisId,
      repository: ctx.repository,
      pullRequestNumber: ctx.pullRequestNumber,
      decision: analysis?.agents?.decision?.decision || 'unknown',
    });
  } catch (err) {
    logger.error('PR analysis failed (polling)', {
      repository: ctx.repository,
      pullRequestNumber: ctx.pullRequestNumber,
      error: err.message,
    });
  }
}

async function checkNow() {
  if (inFlight) {
    return {
      ok: false,
      busy: true,
      message: 'A previous check is still running. Try again shortly.',
    };
  }
  inFlight = true;
  const startedAt = Date.now();
  const repos = watchService.list();
  const perRepo = [];
  try {
    for (const entry of repos) {
      // sequential to avoids racing
      perRepo.push(await checkRepository(entry));
    }
    const totals = perRepo.reduce(
      (acc, r) => {
        acc.pullRequestsChecked += r.pullRequestsSeen;
        acc.analysesScheduled += r.analysesScheduled;
        if (r.error) acc.errors++;
        return acc;
      },
      { pullRequestsChecked: 0, analysesScheduled: 0, errors: 0 }
    );
    lastCheckAt = new Date().toISOString();
    lastResult = {
      ok: true,
      checkedAt: lastCheckAt,
      tookMs: Date.now() - startedAt,
      repositoriesChecked: repos.length,
      pullRequestsChecked: totals.pullRequestsChecked,
      analysesScheduled: totals.analysesScheduled,
      errorCount: totals.errors,
      perRepo,
    };
    logger.info('Polling check finished', {
      repositoriesChecked: lastResult.repositoriesChecked,
      pullRequestsChecked: lastResult.pullRequestsChecked,
      analysesScheduled: lastResult.analysesScheduled,
      errorCount: lastResult.errorCount,
    });
    return lastResult;
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  stopPolling();
  const tick = () => {
    checkNow().catch((err) => logger.warn('Background polling failed', { error: err.message }));
  };
  firstRunTimer = setTimeout(tick, FIRST_RUN_DELAY_MS);
  firstRunTimer.unref?.();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  logger.info('Pull request polling started', {
    intervalMs: POLL_INTERVAL_MS,
    firstRunInMs: FIRST_RUN_DELAY_MS,
    authenticated: !!process.env.GITHUB_TOKEN,
  });
}

function stopPolling() {
  if (firstRunTimer) { clearTimeout(firstRunTimer); firstRunTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function status() {
  return {
    pollIntervalMs: POLL_INTERVAL_MS,
    authenticated: !!process.env.GITHUB_TOKEN,
    lastCheckAt,
    lastResult,
    seenPullRequests: seenPRs.size,
    inFlight,
  };
}

module.exports = { checkNow, startPolling, stopPolling, status };
