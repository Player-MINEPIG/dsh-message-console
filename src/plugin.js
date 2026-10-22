import { ImageCache } from './image-cache.js';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Store } from './store.js';
import { ConsoleService } from './core.js';
import { createDshExecutor, createDshWorkspaces } from './dsh.js';
import { createHandler } from './http.js';
import { GitHubConnector } from './connectors/github.js';
import { BrowserConnector } from './connectors/browser.js';
import { CookieTransport } from './connectors/cookies.js';
import { BilibiliConnector } from './connectors/bilibili.js';
import { GitHubGhConnector } from './connectors/github-gh.js';
import { installAgentTools } from './agent-tools.js';

export const name = 'dsh-message-console';
export const inject = ['loader', 'workspaceRegistry', 'agents', 'agentLoop', 'agentPresets', 'permissionPresets', 'sandboxPolicy', 'sessions', 'sessionPersistence', 'systemPrompt', 'tools', 'llm', 'decisionModels', 'dshPromptAssembler'];
export const Config = Schema.object({ storageDir: Schema.string().required(), cookieFile: Schema.string(), githubAuth: Schema.union(['gh', 'public']).default('gh'), autoSchedule: Schema.boolean().default(true), timeoutMs: Schema.number().min(1000).max(1800000).default(300000) });

export async function apply(ctx, config) {
  const store = await new Store(config.storageDir).start();
  const github = config.githubAuth === 'public' ? new GitHubConnector() : new GitHubGhConnector();
  if (github instanceof GitHubGhConnector) await github.connect();
  const bridge = () => ctx.get?.('messageConsoleBrowser');
  const connectors = {
    github,
    bilibili: new BrowserConnector('bilibili', bridge),
  };
  if(config.cookieFile) {
    const transport = new CookieTransport({cookieFile:config.cookieFile});
    connectors.bilibili = new BilibiliConnector(transport);
  }
  const workspaces = createDshWorkspaces(ctx);
  let service;
  const executor = createDshExecutor(ctx, { createUserMessage, SessionId, service: () => service, timeoutMs: config.timeoutMs, workspaces });
  const imageCache = await new ImageCache(join(config.storageDir, 'images'), { settings: () => store.settings() }).start();
  service = new ConsoleService({ store, connectors, executor, workspaces, imageCache });
  await installAgentTools(ctx, service);
  ctx.provide('messageConsole', service);
  ctx.effect(() => () => service.close());
  ctx.inject(['webServer', 'connection'], web => {
    web.effect(() => web.webServer.register({ kind: 'prefix', path: '/api/dsh-message-console', handler: createHandler(service, req => web.connection.admit(req)) }));
  });
  if (config.autoSchedule !== false) service.startScheduler();
}
