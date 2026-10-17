const publicName = entry => ({ id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id });
export function createModelCatalog(ctx) {
  return {
    async catalog() {
      let providers = [], decisionProfiles = [], defaultDecisionProfile = '', providerError = null, decisionError = null;
      try { providers = ctx.llm.listProviders().filter(entry => typeof entry.id === 'string' && entry.id).map(publicName); }
      catch { providerError = '宿主提供商目录暂不可用，请检查 DSH 后刷新。'; }
      try {
        const config = ctx.decisionModels.config();
        decisionProfiles = (config.profiles ?? []).filter(entry => typeof entry.id === 'string' && entry.id).map(publicName);
        defaultDecisionProfile = typeof config.provider === 'string' ? config.provider : '';
      } catch { decisionError = 'Jev profile 目录暂不可用，仍可保留使用 Jev 默认。'; }
      return { providers, decisionProfiles, defaultDecisionProfile, providerError, decisionError };
    },
    async models(provider) {
      let providers;
      try { providers = ctx.llm.listProviders(); } catch { throw new Error('宿主提供商目录暂不可用，请检查 DSH 后刷新。'); }
      if (!providers.some(entry => entry.id === provider)) throw new Error('此提供商已不在宿主目录中，请刷新并重新选择。');
      try {
        const models = await ctx.llm.listModels(provider);
        return models.filter(entry => entry.provider === provider && typeof entry.id === 'string' && entry.id).map(entry => ({ ...publicName(entry), provider }));
      } catch { throw new Error('此提供商的模型目录暂不可用，请在 DSH 检查连接后重试。'); }
    },
  };
}
