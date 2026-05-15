# security-analyzer

Automated System for Secure Building and Deployment of Web Applications Using
Agent-Based Technologies. The system analyses a public GitHub repository
**before** deployment, runs static security analysis, runs dynamic checks
inside an isolated Docker container, and uses cooperating agents to decide
whether the repository can be deployed, requires manual review, or must be
blocked.

If safe and obvious problems are detected, the user can apply a one-click fix
that mutates **only the temporary cloned copy** of the repository and shows the
diff in the UI. **Nothing is ever pushed back to GitHub.**

---

## Architecture

```
diploma-security-analyzer/
  src/
    server.js                # HTTP server bootstrap
    app.js                   # Express app, routes, static serving
    config/
      constants.js           # Limits, timeouts, ports
      docker.js              # Hardened docker run argument builder
    routes/                  # Express routers per resource
    controllers/             # Request handlers (thin, delegate to services)
    services/
      repository.service.js  # validate URL + git clone --depth 1
      analysis.service.js    # orchestrates static + dynamic + agents
      report.service.js      # builds API response payloads
      fix.service.js         # routes a fix to the right fixer
      state.service.js       # in-memory analysis state + cleanup
    analyzers/
      static/                # secrets, Dockerfile, CI, package.json scans
      dynamic/               # docker-isolated build/test/start checks
    agents/
      securityAgent.js       # security_status + risk_level
      buildTestAgent.js      # pipeline_status
      fixSuggestionAgent.js  # adds fix metadata to each issue
      decisionAgent.js       # final decision: deploy/manual_review/block
    fixers/                  # one module per safe auto-fix strategy
    utils/                   # command runner, file walker, diff, severity
  public/
    index.html               # dashboard
    style.css
    app.js                   # frontend logic
```

## How static analysis works

`staticAnalyzer.js` walks the cloned repository (skipping `.git`, `node_modules`,
`dist`, `build`, `coverage`, `.next`, `.cache`, `vendor`, lock files, binary
and oversized files) and dispatches each file to four scanners:

- **secretScanner.js** — committed `.env*` files, OpenAI keys, GitHub PATs,
  AWS keys, private-key blocks, hardcoded passwords/tokens/secrets.
- **dockerfileScanner.js** — `FROM image:latest`, untagged base images,
  dangerous `RUN` commands.
- **ciScanner.js** — `curl|wget` piped to a shell, `npm install` in CI
  when `package-lock.json` exists, unpinned action references
  (`@main`, `@master`, `@develop`), missing build/test step.
- **packageJsonScanner.js** — invalid JSON, destructive scripts (`rm -rf /`,
  `eval`, `curl|sh`), missing `test`/`build` scripts where relevant.

Each finding is normalised to the issue schema described below.

## How dynamic analysis works

Dynamic analysis runs **only inside Docker** with hardening enabled:

- `--read-only` root filesystem, writable `tmpfs` for `/tmp` and `/work`
- `--cap-drop ALL`, `--security-opt no-new-privileges`
- `--memory 512m`, `--cpus 1`, `--pids-limit 256`
- repository mounted as `/repo:ro` — the container copies it into `/work`
- timeout: 5 minutes (`DOCKER_TIMEOUT_MS = 300_000`)
- stdout/stderr capped at 256 KB
- the Docker socket is **never** mounted

`projectDetector.js` decides what runner to use:

- **Node.js** (`node:20-alpine`): copies repo to `/work`, runs
  `npm ci --ignore-scripts` (or `npm install --ignore-scripts` if no lockfile),
  then `npm run build` if a build script exists, then `npm test` if a real
  test script exists, then `npm start` (backgrounded) and probes ports
  3000, 5173, 8080 over HTTP.
- **Python** (`python:3.10-slim`): runs `python -m compileall .`, installs
  `requirements.txt` if present, and (if a Flask app is detected) starts
  `python -m flask run --host=127.0.0.1 --port=5000` and probes that port.
- **Unknown**: skipped, with a medium-severity issue raised so a human
  reviewer is asked to confirm.

If dynamic analysis times out, `dynamic_analysis.status = "timeout"`, a
medium-severity issue is raised, and the decision agent maps that to
`manual_review`.

## How agent-based decision-making works

Four agents process the data sequentially:

1. **securityAgent** counts static findings by severity and emits
   `security_status` (`ok`/`warning`/`critical`) and `risk_level`
   (`low`/`medium`/`high`/`critical`).
2. **buildTestAgent** maps the dynamic result to a `pipeline_status`
   (`stable`/`warning`/`failed`).
3. **fixSuggestionAgent** annotates every issue with `fix.available`,
   `fix.safe`, and a strategy. Only a small, conservative set of fix types
   is allowed to be safe-and-available.
4. **decisionAgent** applies the rules:
   - any critical/high open issue → **block**
   - failed build or tests → **block**
   - timeout or skipped dynamic analysis → **manual_review**
   - any medium issue still open → **manual_review**
   - otherwise → **deploy**

Ignored or fixed issues drop out of the decision input but stay visible in
the UI.

## How "Apply fix" works

1. The frontend calls `POST /api/issues/:issueId/apply-fix` with the
   `analysisId`.
2. `fix.service.js` looks up the issue, verifies `fix.available === true` and
   `fix.safe === true`, dispatches to the matching fixer, and computes a
   unified diff against the previous file content.
3. The temporary clone on disk is mutated. The original GitHub repository is
   never touched. Nothing is committed and nothing is pushed.
4. The issue's `status` becomes `"fixed"`. The frontend shows the diff and
   recomputes the visible decision.

Allowed safe auto-fixes:

- **Committed `.env`** — file removed from the temporary copy, `.env`
  added to `.gitignore`.
- **`npm install` in GitHub Actions** — replaced with `npm ci`, only if
  `package-lock.json` is still present in the working copy.

Hardcoded secrets, Dockerfile base images, dangerous npm scripts, build
failures, and other risky changes are intentionally **not** auto-fixed and
the UI shows a manual remediation plan instead.

## Issue schema

```json
{
  "id": "iss_<hash>",
  "source": "static" | "dynamic",
  "type": "committed_env_file",
  "severity": "low" | "medium" | "high" | "critical",
  "file": "relative/path",
  "line": 12,
  "message": "Human readable message",
  "recommendation": "Short recommendation",
  "fix": {
    "available": true,
    "strategy": "remove_file | replace_text | update_json | update_yaml | manual",
    "description": "What will be changed",
    "safe": true
  },
  "status": "open" | "ignored" | "fixed",
  "created_at": "ISO date"
}
```

## API

| Method | Path                                | Purpose                                        |
|--------|-------------------------------------|------------------------------------------------|
| GET    | `/api/health`                       | Health probe                                   |
| POST   | `/api/analyze`                      | Run the local analysis pipeline                |
| POST   | `/api/analyze/openai`               | Run local pipeline + OpenAI-agent review       |
| GET    | `/api/analyses/:analysisId`         | Fetch current analysis state                   |
| POST   | `/api/issues/:issueId/apply-fix`    | Apply a safe automated fix                     |
| POST   | `/api/issues/:issueId/ignore`       | Ignore an issue in this run                    |

## OpenAI-agent analysis

The "Analyze with OpenAI agents" button in the UI calls
`POST /api/analyze/openai`. The server still runs the full local pipeline
first (clone → static → dynamic in Docker → local agents), then sends a
**compact** JSON summary (no raw file contents; stdout/stderr tails are
truncated) to OpenAI. The model is prompted to respond as three
cooperating agents (Security / Build-and-Test / Decision) and to return
a structured JSON object that is schema-checked and normalised
server-side.

### Configuration

| Env var          | Purpose                                                    |
|------------------|------------------------------------------------------------|
| `OPENAI_API_KEY` | Your OpenAI API key. Required for the OpenAI route.        |
| `OPENAI_MODEL`   | Optional. Defaults to `gpt-4.1-mini`.                      |

On Windows PowerShell:

```powershell
$env:OPENAI_API_KEY = "sk-..."
npm start
```

On macOS / Linux:

```bash
export OPENAI_API_KEY=sk-...
npm start
```

If `OPENAI_API_KEY` is not set, the OpenAI route returns HTTP 400 with
the message `OpenAI analysis is not configured. Please set OPENAI_API_KEY.`
The plain `/api/analyze` route is unaffected and continues to work.

### Failure behaviour

If the local pipeline succeeds but OpenAI fails (timeout, 5xx, invalid
JSON, etc.), the route returns HTTP 200 with the full local result and
an `openai_error` field containing the message — the UI shows the local
report and a red banner explaining the OpenAI failure.

## Limitations

- Only public `https://github.com/{user}/{repo}` URLs are accepted.
- Dynamic analysis requires a working local Docker daemon. Without Docker,
  the static report is still produced and the decision falls through to
  `manual_review`.
- Analysis state is in-memory; restarting the server clears all sessions.
- The diff utility is a simple LCS-based unified diff suitable for files
  smaller than ~4000 lines.

## Running

Requirements:

- Node.js 18+
- Git on PATH
- Docker Desktop running (for dynamic analysis)

```bash
npm install
npm start
```

Open http://localhost:3000 and paste a GitHub repository URL.

### Windows note

If your Windows username contains non-ASCII characters, Docker Desktop may
refuse to mount paths under `C:\Users\<name>\AppData\Local\Temp`. The server
defaults the analysis temp root to `C:\analyzer-tmp` on Windows. Override
with the `ANALYZER_TMP_ROOT` environment variable if needed.
