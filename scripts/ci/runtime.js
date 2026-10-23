import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.env.DMC_DSH_ROOT || '.local/ci/dsh-host');
const manifest = join(root, 'node_modules/@deepseek-ai/dsh/package.json');
if (!existsSync(manifest)) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dmc-ci-host', private: true, version: '0.0.0' }) + '\n');
  execFileSync('npm', ['install', '--prefix', root, '--save-exact', '--no-audit', '--no-fund', '@deepseek-ai/dsh@0.2.1-rc.2'], { stdio: 'inherit' });
}
assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, '0.2.1-rc.2');
console.log(`DSH 0.2.1-rc.2: ${root}`);
