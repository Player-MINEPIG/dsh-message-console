import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const sharedPlugins = ['dsh-prompt-assembler', 'dsh-jev-plugin'];
const createInstall = name => {
  const path = mkdtempSync(resolve(`.local/ci/${name}-`));
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, private: true, version: '0.0.0' }) + '\n');
  return path;
};
const add = (path, ...packages) => execFileSync('npm', ['install', '--prefix', path, '--no-audit', '--no-fund', ...packages], { stdio: 'inherit' });
const standalone = createInstall('dmc-standalone-install');
add(standalone, archive);
for (const name of sharedPlugins) {
  assert.ok(!existsSync(join(standalone, 'node_modules', name)), `Plugin auto-installed: ${name}`);
  assert.ok(!existsSync(join(standalone, 'node_modules/dsh-message-console/node_modules', name)), `Private plugin copy: ${name}`);
}
const install = createInstall('dmc-ci-install');
for (const name of sharedPlugins) add(install, `${name}@${packageJson.devDependencies[name]}`);
const hostRequire = createRequire(join(install, 'package.json'));
const sharedPaths = Object.fromEntries(sharedPlugins.map(name => [name, realpathSync(hostRequire.resolve(`${name}/package.json`))]));
add(install, archive);
const installed = join(install, 'node_modules/dsh-message-console');
const pluginRequire = createRequire(join(installed, 'package.json'));
for (const name of sharedPlugins) {
  assert.equal(realpathSync(pluginRequire.resolve(`${name}/package.json`)), sharedPaths[name], `Plugin is not shared: ${name}`);
  assert.equal(realpathSync(hostRequire.resolve(`${name}/package.json`)), sharedPaths[name], `Existing plugin was replaced: ${name}`);
}
for (const file of packed.files) {
  const original = execFileSync('tar', ['-xOf', archive, `package/${file.path}`]);
  assert.deepEqual(readFileSync(join(installed, file.path)), original, `Installed file differs: ${file.path}`);
}
const plugin = await import(pathToFileURL(join(installed, 'src/plugin.js')));
assert.equal(plugin.name, 'dsh-message-console');
assert.equal(typeof plugin.apply, 'function');
assert.ok(readFileSync(join(installed, 'dist/client.js'), 'utf8').includes('window.__ModuleLoader__.load'));
assert.equal(packed.version, packageJson.version);
const record = {
  schemaVersion: 1, repository: process.env.GITHUB_REPOSITORY || 'Player-MINEPIG/dsh-message-console',
  candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  name: packed.name, version: packed.version, filename: packed.filename,
  sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  installedFiles: packed.files.length, installed: true,
  sharedPlugins: Object.fromEntries(sharedPlugins.map(name => [name, JSON.parse(readFileSync(sharedPaths[name], 'utf8')).version])),
  noAutoInstalledPlugins: true, reusedHostPlugins: true,
};
writeFileSync(join(directory, 'candidate.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
