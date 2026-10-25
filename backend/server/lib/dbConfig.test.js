// Invalid MongoDB schemes must stop the API with a clear error.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMongoUri, parseDatabaseName } from '../db.js';

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

check('nameless MongoDB URIs receive a safe default database', () => {
  assert.equal(normalizeMongoUri('mongodb://127.0.0.1:27017'), 'mongodb://127.0.0.1:27017/leadai_dev');
  assert.equal(normalizeMongoUri('mongodb://127.0.0.1:27017/?retryWrites=true'), 'mongodb://127.0.0.1:27017/leadai_dev?retryWrites=true');
  assert.equal(normalizeMongoUri('mongodb+srv://cluster.example?retryWrites=true'), 'mongodb+srv://cluster.example/leadai_dev?retryWrites=true');
  assert.equal(normalizeMongoUri('mongodb://127.0.0.1:27017/custom'), 'mongodb://127.0.0.1:27017/custom');
  assert.equal(parseDatabaseName('mongodb+srv://cluster.example'), 'leadai_dev');
});

const wrongScheme = await start({ MONGODB_URI: 'postgres://127.0.0.1:5432/leadai', ALLOW_MEMORY_DB: 'false', NODE_ENV: 'development' });
check('non-MongoDB connection strings are rejected', () => {
  assert.equal(wrongScheme.code, 1);
  assert.match(wrongScheme.output, /must start with mongodb/);
});

console.log(`\n${passed} configuration checks passed.`);
