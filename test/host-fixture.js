import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assembler from 'dsh-prompt-assembler/plugin';

export async function hostFixture(root) {
  const require = createRequire(join(resolve(root), 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const { Context } = await load('cordis'), llm = await load('dsh-llm'), sessions = await load('dsh-session');
  const directory = await mkdtemp(join(tmpdir(), 'dmc-host-'));
  const previousHomes = [process.env.DSH_HOME, process.env.DSH_AGENTS_HOME];
  process.env.DSH_HOME = join(directory, 'home'); process.env.DSH_AGENTS_HOME = join(directory, 'agents');
  const workspace = join(directory, 'workspace'); await mkdir(join(workspace, '.git'), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'HOST_WORKSPACE_POLICY_SENTINEL\nUse available tools and preserve the original data.');
  const ctx = new Context(); ctx.baseUrl = pathToFileURL(join(resolve(root), 'package.json')).href;
  ctx.provide('sessionController', { async inspect(id) { const session = ctx.sessions.get(id); return session ? { meta: session.header, events: session.snapshotEvents() } : undefined; } });
  const mount = async (name, config = {}) => { const module = await load(name); await ctx.plugin(module.default ?? module, config); };
  await mount('cordis-plugin-loader', { baseUrl: ctx.baseUrl });
  ctx.loader.builtins.group = (await load('cordis-plugin-loader')).Group;
  await ctx.plugin((await load('dsh-system-prompt')).SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, personaPrefix: 'Offline host' });
  for (const name of ['session', 'agent', 'session-projection', 'llm', 'tools', 'agent-loop']) await mount(`dsh-${name}`, name === 'agent-loop' ? { agents: [] } : {});
  await mount('dsh-session-persistence-jsonl', { root: join(directory, 'sessions') });
  for (const [name, config] of [
    ['sandbox-policy', { mode: 'danger-full-access', workspaceRoot: workspace }], ['fs-sandbox', { cwd: workspace }],
    ['working-directory', {}], ['user-approval', { policy: 'never' }], ['subprocess-local', {}], ['sandbox-local', {}],
    ['bash-sandbox', {}], ['ptc-runtime-node', {}], ['shell-env', {}], ['permission-presets', {}], ['agent-preset-registry', { default: 'standard' }],
  ]) await mount(`dsh-${name}`, config);
  const plugins = [
    { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'planning', name: 'cordis:group', group: true, isolate: { planMode: true }, config: [{ id: 'plan', name: '@deepseek-ai/dsh-plan-mode', config: { section: 'Plan mode. Read and discuss without saving changes.' } }] },
  ];
  await ctx.agentPresets.register({ id: 'standard', plugins });
  await ctx.agentPresets.register({ id: 'ptc', plugins: [...plugins, { id: 'presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'ptc' } }] });
  await ctx.plugin(assembler, { storageDir: join(directory, 'assembler') });
  await mount('dsh-storage'); await mount('dsh-storage-json', { root: join(directory, 'storage') });
  await mount('dsh-storage-domain', { backend: 'json' }); await mount('dsh-workspace'); await mount('dsh-session-query');
  const registeredWorkspace = await ctx.workspaceRegistry.create(workspace, 'Offline workspace');
  return { ctx, llm, sessions, directory, workspace, registeredWorkspace, load,
    async close() {
      await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
      for (const [index, name] of ['DSH_HOME', 'DSH_AGENTS_HOME'].entries()) if (previousHomes[index] === undefined) delete process.env[name]; else process.env[name] = previousHomes[index];
    },
  };
}
