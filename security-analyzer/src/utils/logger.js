function ts() {
  return new Date().toISOString();
}

function format(level, msg, meta) {
  let line = `[${ts()}] [${level}] ${msg}`;
  if (meta !== undefined) {
    if (meta instanceof Error) {
      line += ` ${meta.stack || meta.message}`;
    } else {
      try { line += ` ${JSON.stringify(meta)}`; } catch { /* ignore */ }
    }
  }
  return line;
}

module.exports = {
  info: (m, meta) => console.log(format('INFO', m, meta)),
  warn: (m, meta) => console.warn(format('WARN', m, meta)),
  error: (m, meta) => console.error(format('ERROR', m, meta)),
  debug: (m, meta) => {
    if (process.env.DEBUG) console.log(format('DEBUG', m, meta));
  },
};
