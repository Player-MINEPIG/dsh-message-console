import { modelRoute } from './model-selection.js';

const sameRoute = (left, right) => left.provider === right.provider && left.model === right.model;
async function defaultFailure(ctx, error) {
  const { LlmError } = await (ctx.loader ? ctx.loader.import('@deepseek-ai/dsh-llm') : import('@deepseek-ai/dsh-llm'));
  const failure = error.failure ?? error;
  return new LlmError(`看点什么全局默认模型不可用，请检查全局模型配置：${error.message}`, failure.code ?? 'MODEL_DEFAULT_UNAVAILABLE', {
    cause: error,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
  });
}

export async function resolveModelFallback(ctx, config, defaults, signal) {
  try {
    if (!config.provider || !config.model) throw new Error('未选择提供商或模型');
    await ctx.llm.resolveCallConfig(config, signal);
    return config;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ABORTED') throw error;
    const fallback = defaults();
    try {
      if (!fallback.provider || !fallback.model) throw new Error('未选择全局提供商或模型');
      await ctx.llm.resolveCallConfig(fallback, signal);
    } catch (cause) { signal?.throwIfAborted(); throw await defaultFailure(ctx, cause); }
    ctx.logger?.warn(`看点什么模型 ${config.provider}/${config.model} 不可用，改用全局默认 ${fallback.provider}/${fallback.model}：${error.message}`);
    return fallback;
  }
}

export function attachModelFallback(ctx, agent, service) {
  let turn, forcedDefault = false, attempted;
  const defaults = () => {
    const binding = service.sessionBinding(String(agent.session.id), agent.session.header.cwd);
    if (!binding) throw new Error('无法确认模型回退的会话绑定');
    return modelRoute(service.store.settings(), binding.role === 'supervisor');
  };
  const request = agent.ctx.on('agent/request', async (event, next) => {
    const config = await next();
    if (turn !== event.turn) { turn = event.turn; forcedDefault = false; }
    if (forcedDefault) {
      attempted = defaults();
      try {
        if (!attempted.provider || !attempted.model) throw new Error('未选择全局提供商或模型');
        await ctx.llm.resolveCallConfig(attempted, event.signal);
      } catch (error) { event.signal?.throwIfAborted(); throw await defaultFailure(ctx, error); }
    } else {
      attempted = await resolveModelFallback(ctx, config, defaults, event.signal);
      forcedDefault = attempted !== config;
    }
    return attempted;
  });
  const error = agent.ctx.on('agent/request-error', async (event, next) => {
    event.signal?.throwIfAborted();
    if (event.failure.code === 'ABORTED') return next();
    const fallback = defaults();
    if (forcedDefault || sameRoute(attempted ?? {}, fallback)) throw await defaultFailure(ctx, event.failure);
    forcedDefault = true;
    ctx.logger?.warn(`看点什么模型请求失败，重试当前请求并使用全局默认 ${fallback.provider}/${fallback.model}：${event.failure.message}`);
    return { kind: 'retry' };
  });
  return () => { request(); error(); };
}
