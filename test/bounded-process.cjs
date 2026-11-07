const { spawn } = require('node:child_process');

async function runBounded(command, args, options) {
  const { timeout, cwd, env, stdio, maxBuffer = 1024 * 1024 } = options;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647)
    throw new RangeError('A positive bounded subprocess timeout is required');
  if (!Number.isInteger(maxBuffer) || maxBuffer <= 0)
    throw new RangeError('A positive subprocess output bound is required');
  const grouped = process.platform !== 'win32';
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: grouped,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      outputBytes = 0;
    let error,
      cleanupError,
      deadline,
      closingDeadline,
      settled = false;
    function stopOwnedTree() {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      } catch (failure) {
        if (failure.code !== 'ESRCH')
          cleanupError = Object.assign(
            new Error('Owned subprocess cleanup failed'),
            {
              code: failure.code,
            },
          );
      }
    }
    function finish(status, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(closingDeadline);
      resolve({
        pid: child.pid,
        status: error || cleanupError ? null : status,
        signal,
        stdout,
        stderr,
        error: error || cleanupError,
        cleanupError,
      });
    }
    function boundClosure() {
      if (closingDeadline) return;
      closingDeadline = setTimeout(() => {
        cleanupError ||= Object.assign(
          new Error('Owned subprocess did not close after termination'),
          {
            code: 'EPROCESSTREE',
          },
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null, null);
      }, 2000);
    }
    function capture(stream, chunk) {
      if (error) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxBuffer) {
        error = Object.assign(
          new Error('Owned subprocess output exceeded its bound'),
          {
            code: 'ENOBUFS',
          },
        );
        stopOwnedTree();
        boundClosure();
      } else if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
    }
    child.stdout
      ?.setEncoding('utf8')
      .on('data', (chunk) => capture('stdout', chunk));
    child.stderr
      ?.setEncoding('utf8')
      .on('data', (chunk) => capture('stderr', chunk));
    child.on('error', (failure) => {
      error ||= Object.assign(new Error('Owned subprocess could not start'), {
        code: failure.code,
      });
      stopOwnedTree();
      boundClosure();
    });
    child.on('exit', () => {
      stopOwnedTree();
      boundClosure();
    });
    child.on('close', finish);
    deadline = setTimeout(() => {
      error = Object.assign(
        new Error('Owned subprocess exceeded its execution deadline'),
        {
          code: 'ETIMEDOUT',
        },
      );
      stopOwnedTree();
      boundClosure();
    }, timeout);
  });
}

module.exports = { runBounded };
