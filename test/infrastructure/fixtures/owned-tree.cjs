const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [role, folder, mode] = process.argv.slice(2);
fs.writeFileSync(path.join(folder, `${role}.pid`), String(process.pid));
if (role === 'root' || role === 'branch')
  spawn(
    process.execPath,
    [__filename, role === 'root' ? 'branch' : 'leaf', folder, mode],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
if (role === 'root' && mode === 'complete') {
  const wait = setInterval(() => {
    if (fs.existsSync(path.join(folder, 'leaf.pid'))) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 10);
}

setTimeout(() => process.exit(0), 8000);
