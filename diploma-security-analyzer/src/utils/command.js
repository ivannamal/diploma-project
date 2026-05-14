const { execFile } = require('child_process');

// wrapper around child_process.execFile (no shell, no command injection)
function run(file, args, opts = {}) {
  const {
    timeoutMs = 60_000,
    cwd,
    env,
    maxOutputBytes = 1_000_000,
  } = opts;

  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      env: env || process.env,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      shell: false,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      let outStr = (stdout || '').toString();
      let errStr = (stderr || '').toString();
      let truncated = false;
      if (outStr.length > maxOutputBytes) { outStr = outStr.slice(0, maxOutputBytes); truncated = true; }
      if (errStr.length > maxOutputBytes) { errStr = errStr.slice(0, maxOutputBytes); truncated = true; }

      if (err) {
        const errCode = err.code;
        const timedOut = err.killed === true;
        if (errCode === 'ENOBUFS') truncated = true;
        const exitCode = typeof errCode === 'number' ? errCode : -1;
        return resolve({
          code: exitCode,
          stdout: outStr,
          stderr: errStr || err.message,
          timedOut,
          truncated,
          error: err.message,
        });
      }
      resolve({ code: 0, stdout: outStr, stderr: errStr, timedOut: false, truncated });
    });
  });
}

module.exports = { run };
