import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: "export { SourceEditor } from './src/source-editor.jsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'source-editor-hooks', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'source-editor-hooks' }));
    builder.onLoad({ filter: /.*/, namespace: 'source-editor-hooks' }, () => ({ contents: `
      export const useState = (...args) => globalThis.sourceEditorHooks.useState(...args);
      export const useRef = (...args) => globalThis.sourceEditorHooks.useRef(...args);
      export const useEffect = (...args) => globalThis.sourceEditorHooks.useEffect(...args);
      export const useCallback = (...args) => globalThis.sourceEditorHooks.useCallback(...args);
      const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
      export default { createElement };
    ` }));
  } }],
});
const { SourceEditor } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const field = (tree, label) => nodes(nodes(tree).find(node => node.type === 'label' && text(node) === label)).find(node => ['input', 'textarea'].includes(node.type));
const link = tree => nodes(tree).find(node => node.type === 'input' && node.props.placeholder?.startsWith('GitHub仓库链接'));
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fixture(t) {
  const slots = [], effects = [], calls = [];
  let index = 0;
  const unchanged = (previous, dependencies) => previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]));
  globalThis.sourceEditorHooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useRef(initial) { const slot = index++; return slots[slot] ??= { current: initial }; },
    useEffect(effect, dependencies) {
      const slot = index++, previous = slots[slot];
      if (unchanged(previous, dependencies)) return;
      effects.push(() => { previous?.cleanup?.(); slots[slot] = { dependencies, cleanup: effect() }; });
    },
    useCallback(callback, dependencies) {
      const slot = index++, previous = slots[slot];
      if (!unchanged(previous, dependencies)) slots[slot] = { callback, dependencies };
      return slots[slot].callback;
    },
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', (url, init) => new Promise(resolve => {
    assert.equal(url, '/api/dsh-message-console/sources/suggest');
    calls.push({ body: JSON.parse(init.body), signal: init.signal,
      resolve: fields => resolve({ ok: true, json: async () => ({ fields, access: 'public' }) }) });
  }));
  const render = () => {
    index = 0;
    const tree = SourceEditor({ state: { parameters: {}, settings: {}, workspaces: [] }, catalog: {}, action() {}, onBack() {}, onSaved() {} });
    while (effects.length) effects.shift()();
    return tree;
  };
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); delete globalThis.sourceEditorHooks; });
  link(render()).props.onChange({ target: { value: 'owner/repo' } });
  link(render()).props.onBlur();
  render();
  t.mock.timers.tick(400);
  assert.equal(calls.length, 1);
  return { calls, render };
}

test('returning to a source type within the debounce window restarts canceled metadata and preserves manual fields', async t => {
  const f = fixture(t);
  field(f.render(), 'Pull request').props.onChange({ target: { checked: false } });
  f.render();
  t.mock.timers.tick(200);
  field(f.render(), 'Pull request').props.onChange({ target: { checked: true } });
  f.render();
  t.mock.timers.tick(400);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls.length, 2, 'the canceled original selection must be fetched again');
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
  field(f.render(), '名称').props.onChange({ target: { value: '手动名称' } });
  f.calls[1].resolve({ name: '自动名称', description: '新描述' }); await flush();
  f.calls[0].resolve({ name: '过时名称', description: '过时描述' }); await flush();
  assert.equal(field(f.render(), '名称').props.value, '手动名称');
  assert.equal(field(f.render(), '来源简介').props.value, '新描述');
});

test('successful metadata is not requested again when the same link is revisited without changing its selection', async t => {
  const f = fixture(t);
  f.calls[0].resolve({ name: '仓库名称', description: '仓库简介' }); await flush();
  assert.equal(field(f.render(), '名称').props.value, '仓库名称');
  link(f.render()).props.onBlur();
  field(f.render(), '名称').props.onChange({ target: { value: '手动名称' } });
  f.render();
  t.mock.timers.tick(1200);
  assert.equal(f.calls.length, 1);
  assert.equal(field(f.render(), '名称').props.value, '手动名称');
});
