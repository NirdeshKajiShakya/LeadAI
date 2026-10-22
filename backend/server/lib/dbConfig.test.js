// A missing or malformed MongoDB configuration must stop the API with a clear error.
// The previous silent in-memory fallback is what made each developer see different data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function start(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: backendRoot,
      env: { ...process.env, PORT: '4199', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 'timeout', output });
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('database configuration checks\n');

const missing = await start({ MONGODB_URI: '', ALLOW_MEMORY_DB: 'false', NODE_ENV: 'development' });
check('missing MONGODB_URI exits instead of silently using memory', () => {
  assert.equal(missing.code, 1);
  assert.match(missing.output, /MONGODB_URI is not set/);
});

const nameless = await start({ MONGODB_URI: 'mongodb://127.0.0.1:27017', ALLOW_MEMORY_DB: 'false', NODE_ENV: 'development' });
check('a URI without a database name is rejected', () => {
  assert.equal(nameless.code, 1);
  assert.match(nameless.output, /must name a database/);
});

const wrongScheme = await start({ MONGODB_URI: 'postgres://127.0.0.1:5432/leadai', ALLOW_MEMORY_DB: 'false', NODE_ENV: 'development' });
check('non-MongoDB connection strings are rejected', () => {
  assert.equal(wrongScheme.code, 1);
  assert.match(wrongScheme.output, /must start with mongodb/);
});

console.log(`\n${passed} configuration checks passed.`);
