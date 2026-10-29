import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: "export {ConsoleApp,Detail,Draft} from './src/client.jsx'; export {FeedbackEditor,FeedbackPanel} from './src/feedback-view.jsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.css': 'empty' },
  plugins: [{ name: 'controlled-ui', setup(builder) {
    builder.onResolve({ filter: /^react(-dom)?$/ }, args => ({ path: args.path, namespace: 'controlled-ui' }));
    builder.onLoad({ filter: /.*/, namespace: 'controlled-ui' }, () => ({ contents: `
      export const useState = (...args) => globalThis.asyncUiHooks.useState(...args);
      export const useRef = (...args) => globalThis.asyncUiHooks.useRef(...args);
      export const useCallback = (...args) => globalThis.asyncUiHooks.useCallback(...args);
      export const useEffect = (...args) => globalThis.asyncUiHooks.useEffect(...args);
      export const useLayoutEffect = () => {};
      export const createPortal = child => child;
      const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
      export default { useState, useRef, useEffect, useLayoutEffect, useCallback, createElement, Fragment: 'fragment' };
    ` }));
    builder.onLoad({ filter: /\/src\/client\.jsx$/ }, async args => ({ contents: `${await readFile(args.path, 'utf8')}\nexport {Detail,Draft};`, loader: 'jsx' }));
    builder.onLoad({ filter: /\/src\/ui-shared\.jsx$/ }, async args => {
      const source = await readFile(args.path, 'utf8'), start = source.indexOf('export function useRemoteResource('), end = source.indexOf('export function ResourceError(');
      return { contents: `${source.slice(0, start)}export const useRemoteResource = path => globalThis.asyncUiResource(path);\n${source.slice(end)}`, loader: 'jsx' };
    });
  } }],
});
const ui = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const component = (tree, name) => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === name);
const failure = { data: null, error: '临时网络错误', loading: false, retry() {} };
const overview = { sources: [{ id: 'a', name: '来源A', connection: {} }, { id: 'b', name: '来源B', connection: {} }], platforms: [], settings: {} };

function fixture(t, Component, props = {}, resource = () => failure, runEffects = false) {
  const slots = [], effects = []; let index = 0;
  globalThis.asyncUiHooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { value: typeof initial === 'function' ? initial() : initial, set: value => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value; } };
      return [slots[slot].value, slots[slot].set];
    },
    useRef(initial) { const slot = index++; return slots[slot] ??= { current: initial }; },
    useCallback(callback, dependencies) {
      const slot = index++, previous = slots[slot];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) slots[slot] = { callback, dependencies };
      return slots[slot].callback;
    },
    useEffect(effect, dependencies) {
      if (!runEffects) return;
      const slot = index++, previous = slots[slot];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      effects.push(() => { previous?.cleanup?.(); slots[slot] = { dependencies, cleanup: effect() }; });
    },
  };
  globalThis.asyncUiResource = resource;
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); delete globalThis.asyncUiHooks; delete globalThis.asyncUiResource; });
  return () => { index = 0; const tree = Component(props); while (effects.length) effects.shift()(); return tree; };
}

test('failed feedback load stops its loading message and can retry in place', t => {
  let retries = 0;
  const render = fixture(t, ui.FeedbackEditor, { item: { id: 'i' } }, () => ({ ...failure, retry: () => retries++ }));
  const tree = render();
  assert.doesNotMatch(text(tree), /正在加载评价/);
  assert.equal(component(tree, 'ResourceError').props.error, failure.error);
  button(tree, '重试加载评价').props.onClick(); assert.equal(retries, 1);
});

test('failed batch, content detail and draft loads do not continue showing loading', t => {
  for (const [Component, props, message] of [
    [ui.FeedbackPanel, { sources: [], batchId: 'batch' }, /正在加载批次详情/],
    [ui.Detail, { selection: { id: 'i' }, source: {} }, /正在加载详情/],
    [ui.Draft, { draft: { id: 'd', status: 'ready' }, source: { connection: {} } }, /正在加载草稿/],
  ]) {
    const render = fixture(t, Component, props);
    assert.doesNotMatch(text(render()), message);
  }
});

test('failed overview stops connection message and failed source editor resources can retry', t => {
  const render = fixture(t, ui.ConsoleApp);
  assert.doesNotMatch(text(render()), /正在连接消息服务/);
  let retries = 0;
  globalThis.asyncUiResource = path => path?.startsWith('overview?') ? { data: overview, loading: false, error: '' } : { ...failure, retry: () => retries++ };
  button(render(), '＋ 添加来源').props.onClick();
  const tree = render();
  assert.doesNotMatch(text(tree), /正在加载来源配置/);
  button(tree, '重试加载来源配置').props.onClick(); assert.equal(retries, 1, 'retry the failed workspace lookup when adding a source');
  button(tree, '总览').props.onClick();
  component(render(), 'Dashboard').props.onNavigate({ kind: 'source', id: 'a' });
  component(render(), 'SourcePage').props.onEdit();
  button(render(), '重试加载来源配置').props.onClick(); assert.equal(retries, 3, 'retry both failed lookups when editing a source');
});

for (const navigateAway of [false, true]) test(`learning response ${navigateAway ? 'preserves newer navigation and unsaved feedback' : 'opens its batch when navigation is unchanged'}`, async t => {
  let release;
  t.mock.method(globalThis, 'fetch', (_url, init) => init.method === 'POST' && JSON.parse(init.body).sourceId === 'a'
    ? new Promise(resolve => { release = value => resolve({ ok: true, json: async () => value }); })
    : Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => false };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const render = fixture(t, ui.ConsoleApp, {}, path => path?.startsWith('overview?') ? { data: overview, loading: false, error: '' } : failure);
  component(render(), 'Dashboard').props.onNavigate({ kind: 'source', id: 'a' });
  const pending = component(render(), 'SourcePage').props.onLearn();
  if (navigateAway) {
    button(render(), '总览').props.onClick();
    component(render(), 'Dashboard').props.onNavigate({ kind: 'source', id: 'b' });
    component(render(), 'SourcePage').props.onSelect({ id: 'item-b', version: 'v1' });
    component(render(), 'SourcePage').props.detail.props.onFeedbackDirty(true);
  }
  release({ id: 'batch-a' }); await pending;
  if (navigateAway) {
    assert.equal(component(render(), 'SourcePage')?.props.source.id, 'b');
    assert.equal(component(render(), 'SourcePage').props.selected, 'item-b');
    button(render(), '总览').props.onClick();
    assert.equal(component(render(), 'SourcePage')?.props.source.id, 'b', 'unsaved feedback still prevents leaving when confirmation is declined');
  } else {
    assert.equal(component(render(), 'FeedbackPanel').props.batchId, 'batch-a');
  }
});

for (const cancel of [false, true]) test(`source save completion ${cancel ? 'does not reopen a canceled editor' : 'opens the saved source'}`, t => {
  const render = fixture(t, ui.ConsoleApp, {}, path => path?.startsWith('overview?')
    ? { data: overview, loading: false, error: '' }
    : path === 'workspaces' ? { data: [], loading: false, error: '' } : failure);
  button(render(), '＋ 添加来源').props.onClick();
  const editor = component(render(), 'SourceEditor');
  if (cancel) editor.props.onBack();
  editor.props.onSaved('a');
  assert.equal(Boolean(component(render(), 'SourcePage')), !cancel);
  assert.equal(Boolean(component(render(), 'Dashboard')), cancel);
});

for (const scenario of ['new-edit', 'confirmed-old-edit', 'confirmed-then-new-edit']) test(`learning navigation respects feedback editing: ${scenario}`, async t => {
  let release;
  t.mock.method(globalThis, 'fetch', (_url, init) => JSON.parse(init.body).sourceId === 'a'
    ? new Promise(resolve => { release = value => resolve({ ok: true, json: async () => value }); })
    : Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => true };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const render = fixture(t, ui.ConsoleApp, {}, path => path?.startsWith('overview?') ? { data: overview, loading: false, error: '' } : failure);
  component(render(), 'Dashboard').props.onNavigate({ kind: 'source', id: 'a' });
  component(render(), 'SourcePage').props.onSelect({ id: 'item-a', version: 'v1' });
  const onDirty = component(render(), 'SourcePage').props.detail.props.onFeedbackDirty;
  assert.equal(component(render(), 'SourcePage').props.detail.props.onFeedbackDirty, onDirty);
  if (scenario !== 'new-edit') onDirty(true);
  const pending = component(render(), 'SourcePage').props.onLearn();
  if (scenario !== 'confirmed-old-edit') onDirty(true);
  release({ id: 'batch-a' }); await pending;
  if (scenario === 'confirmed-old-edit') {
    assert.equal(component(render(), 'FeedbackPanel').props.batchId, 'batch-a');
  } else {
    assert.equal(component(render(), 'SourcePage')?.props.selected, 'item-a');
    globalThis.window.confirm = () => false;
    button(render(), '总览').props.onClick();
    assert.equal(component(render(), 'SourcePage')?.props.selected, 'item-a');
  }
});

test('each new feedback text edit reports dirty while unchanged renders do not', t => {
  const changes = [], saved = { text: '', revision: 1 }, previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const render = fixture(t, ui.FeedbackEditor, { item: { id: 'i' }, onDirtyChange: value => changes.push(value) }, () => ({ data: saved, error: '', loading: false }), true);
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  render();
  for (const value of ['新的评价', '新的评价继续补充']) {
    nodes(render()).find(node => node.type === 'textarea').props.onChange({ target: { value } });
    render();
  }
  assert.equal(changes.filter(Boolean).length, 2);
  const count = changes.length;
  render(); assert.equal(changes.length, count);
});
