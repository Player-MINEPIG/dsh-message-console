import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve('.local/ci/candidate');
mkdirSync(directory, { recursive: true });
const entries = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
assert.equal(entries.length, 1);
const packed = entries[0];
assert.equal(packed.name, 'dsh-message-console');
for (const file of packed.files) {
  assert.ok(!/(^|\/)(\.local|\.git|node_modules)(\/|$)/.test(file.path), `Private package file: ${file.path}`);
  assert.ok(!/\.(tgz|sqlite|pem)$/.test(file.path), `Unexpected package file: ${file.path}`);
}
const archive = join(directory, packed.filename);
const install = resolve('.local/ci/package-install');
mkdirSync(install, { recursive: true });
writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'dmc-ci-install', private: true, version: '0.0.0' }) + '\n');
execFileSync('npm', ['install', '--prefix', install, '--no-audit', '--no-fund', archive], { stdio: 'inherit' });
const installed = join(install, 'node_modules/dsh-message-console');
for (const file of packed.files) {
  const original = execFileSync('tar', ['-xOf', archive, `package/${file.path}`]);
  assert.deepEqual(readFileSync(join(installed, file.path)), original, `Installed file differs: ${file.path}`);
}
const plugin = await import(pathToFileURL(join(installed, 'src/plugin.js')));
assert.equal(plugin.name, 'dsh-message-console');
assert.equal(typeof plugin.apply, 'function');
assert.ok(readFileSync(join(installed, 'dist/client.js'), 'utf8').includes('window.__ModuleLoader__.load'));
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(packed.version, packageJson.version);
const record = {
  schemaVersion: 1, repository: process.env.GITHUB_REPOSITORY || 'Player-MINEPIG/dsh-message-console',
  candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  name: packed.name, version: packed.version, filename: packed.filename,
  sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  installedFiles: packed.files.length, installed: true,
};
writeFileSync(join(directory, 'candidate.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
