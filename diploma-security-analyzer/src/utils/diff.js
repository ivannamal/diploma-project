// Simple unified-style diff using LCS. Suitable for files smaller than
// ~4000 lines. Above that, falls back to a trivial "remove all + add all"
// representation to keep memory bounded.

function splitLines(s) {
  return (s || '').split(/\r?\n/);
}

function lcsTable(a, b) {
  const n = a.length, m = b.length;
  if (n > 4000 || m > 4000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function unifiedDiff(before, after, fileLabel) {
  const a = splitLines(before);
  const b = splitLines(after);
  const dp = lcsTable(a, b);

  const out = [];
  out.push(`--- a/${fileLabel}`);
  out.push(`+++ b/${fileLabel}`);

  if (!dp) {
    for (const line of a) out.push('-' + line);
    for (const line of b) out.push('+' + line);
    return out.join('\n');
  }

  let i = 0, j = 0;
  const n = a.length, m = b.length;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(' ' + a[i]);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push('-' + a[i]);
      i++;
    } else {
      out.push('+' + b[j]);
      j++;
    }
  }
  while (i < n) { out.push('-' + a[i]); i++; }
  while (j < m) { out.push('+' + b[j]); j++; }

  return out.join('\n');
}

function fileRemovedDiff(before, fileLabel) {
  return unifiedDiff(before, '', fileLabel);
}

function fileAddedDiff(after, fileLabel) {
  return unifiedDiff('', after, fileLabel);
}

module.exports = { unifiedDiff, fileRemovedDiff, fileAddedDiff };
