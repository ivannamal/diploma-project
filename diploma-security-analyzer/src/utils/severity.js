const ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
const ALL = ['low', 'medium', 'high', 'critical'];

function compareSeverity(a, b) {
  // descending: critical first
  return (ORDER[b] ?? 0) - (ORDER[a] ?? 0);
}

function maxSeverity(list) {
  let m = 'low';
  for (const s of list) {
    if ((ORDER[s] ?? 0) > (ORDER[m] ?? 0)) m = s;
  }
  return m;
}

function isAtLeast(s, min) {
  return (ORDER[s] ?? 0) >= (ORDER[min] ?? 0);
}

function countBySeverity(issues) {
  const out = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const i of issues) {
    if (out[i.severity] !== undefined) out[i.severity]++;
  }
  return out;
}

module.exports = { ORDER, ALL, compareSeverity, maxSeverity, isAtLeast, countBySeverity };
