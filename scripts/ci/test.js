import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.env.DMC_DSH_ROOT || '.local/ci/dsh-host');
const require = createRequire(join(root, 'package.json'));
assert.equal(JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version, '0.2.1-rc.2');
const files = readdirSync('test').filter(name => name.endsWith('.test.js')).sort().map(name => join('test', name));
mkdirSync('.local/ci', { recursive: true });
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  env: { ...process.env, DMC_DSH_ROOT: root }, stdio: ['ignore', 'pipe', 'inherit'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.on('error', error => { throw error; });
const code = await new Promise(resolve => child.on('close', resolve));
writeFileSync('.local/ci/tests.tap', output);
assert.equal(code, 0, 'Normal test suite failed');
assert.match(output, /^# tests [1-9]\d*$/m, 'Missing test summary');
assert.match(output, /^# skipped 0$/m, 'CI must execute host tests without skips');
assert.match(output, /^# cancelled 0$/m, 'CI must finish every test');
