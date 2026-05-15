const path = require('path');
const { readFileSafe } = require('../../utils/fileWalker');

const PATTERNS = [
  {
    name: 'github_token',
    re: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    severity: 'critical',
    message: 'GitHub personal access token detected.',
  },
  {
    name: 'openai_key',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/,
    severity: 'critical',
    message: 'Possible OpenAI API key detected (sk-... pattern).',
  },
  {
    name: 'aws_access_key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    severity: 'critical',
    message: 'AWS access key ID detected (AKIA... pattern).',
  },
  {
    name: 'aws_secret_key',
    re: /aws(?:_|\s|-)*secret(?:_|\s|-)*access(?:_|\s|-)*key["'\s:=]+([A-Za-z0-9/+=]{40})/i,
    severity: 'critical',
    message: 'Possible AWS secret access key detected.',
  },
  {
    name: 'private_key_block',
    re: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/,
    severity: 'critical',
    message: 'Private key block detected.',
  },
  {
    name: 'hardcoded_password',
    re: /(?:^|[^A-Za-z0-9_])password\s*[:=]\s*["'][^"'\n]{6,}["']/i,
    severity: 'high',
    message: 'Hardcoded password detected.',
  },
  {
    name: 'hardcoded_secret',
    re: /\b(?:secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i,
    severity: 'high',
    message: 'Hardcoded secret / API key / access token detected.',
  },
  {
    name: 'hardcoded_token',
    re: /\btoken\s*[:=]\s*["'][A-Za-z0-9_.\-]{20,}["']/i,
    severity: 'high',
    message: 'Hardcoded token detected.',
  },
];

const COMMITTED_ENV_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
  '.env.test',
]);

async function scan(repoPath, files) {
  const issues = [];

  for (const file of files) {
    const baseName = path.basename(file.relative);

    if (COMMITTED_ENV_NAMES.has(baseName)) {
      issues.push({
        source: 'static',
        type: 'committed_env_file',
        severity: 'high',
        file: file.relative,
        line: null,
        message: `Environment file "${baseName}" is committed to the repository.`,
        recommendation:
          'Remove the .env file from the repository, add it to .gitignore, and provide a .env.example with non-secret placeholders.',
      });
    }

    const content = readFileSafe(file.full);
    if (!content) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;

      for (const p of PATTERNS) {
        if (p.re.test(line)) {
          issues.push({
            source: 'static',
            type: `secret_${p.name}`,
            severity: p.severity,
            file: file.relative,
            line: i + 1,
            message: p.message,
            recommendation:
              'Replace the value with an environment variable, rotate the credential, and remove it from git history.',
          });
          break;
        }
      }
    }
  }

  return issues;
}

module.exports = { scan };
