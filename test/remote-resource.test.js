import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: "export { useRemoteResource } from './src/ui-shared.jsx';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{
    name: 'hook-lifecycle',
    setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hook-lifecycle' }));
      builder.onLoad({ filter: /.*/, namespace: 'hook-lifecycle' }, () => ({ contents: `
        export default {};
        export const useState = (...args) => globalThis.remoteResourceHooks.useState(...args);
        export const useRef = (...args) => globalThis.remoteResourceHooks.useRef(...args);
        export const useEffect = (...args) => globalThis.remoteResourceHooks.useEffect(...args);
        export const useCallback = (...args) => globalThis.remoteResourceHooks.useCallback(...args);
      ` }));
    },
  }],
});
const { useRemoteResource } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fixture(t, path = 'learning?page=1', options = { pollMs: 3000 }) {
  const slots = [], effects = [], calls = [];
  let index = 0, mounted = true, writesAfterUnmount = 0;
  const hooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], value => {
        if (!mounted) writesAfterUnmount++;
        slots[slot] = typeof value === 'function' ? value(slots[slot]) : value;
      }];
    },
    useRef(initial) {
      const slot = index++;
      return slots[slot] ??= { current: initial };
    },
    useCallback(callback, dependencies) {
      const slot = index++, previous = slots[slot];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) slots[slot] = { callback, dependencies };
      return slots[slot].callback;
    },
    useEffect(effect, dependencies) {
      const slot = index++, previous = slots[slot];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      effects.push(() => {
        previous?.cleanup?.();
        slots[slot] = { dependencies, cleanup: effect() };
      });
    },
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(globalThis, 'fetch', (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, signal: init.signal, resolve: value => resolve({ ok: true, json: async () => value }), reject });
  }));
  const render = (nextPath = path, nextOptions = options) => {
    path = nextPath; options = nextOptions; index = 0;
    globalThis.remoteResourceHooks = hooks;
    const resource = useRemoteResource(path, options);
    while (effects.length) effects.shift()();
    return resource;
  };
  const unmount = () => {
    if (!mounted) return;
    for (const slot of slots) slot?.cleanup?.();
    mounted = false;
  };
  t.after(() => { unmount(); delete globalThis.remoteResourceHooks; });
  render();
  return { calls, render, unmount, writesAfterUnmount: () => writesAfterUnmount };
}

test('slow learning history loads before scheduling the next poll', async t => {
  const f = fixture(t), history = { items: [{ id: 'batch' }] };
  t.mock.timers.tick(9000);
  f.calls[0].resolve(history); await flush();
  assert.deepEqual(f.render().data, history);
  assert.equal(f.render().loading, false);
  assert.equal(f.calls.length, 1, 'a pending request does not overlap with polls');
  t.mock.timers.tick(2999); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1); assert.equal(f.calls.length, 2);
});

test('slow errors end loading and a later poll can recover', async t => {
  const f = fixture(t);
  t.mock.timers.tick(9000);
  f.calls[0].reject(new Error('网络暂时不可用')); await flush();
  assert.equal(f.render().error, '网络暂时不可用');
  assert.equal(f.render().loading, false);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(3000);
  const history = { items: [] };
  f.calls[1].resolve(history); await flush();
  assert.deepEqual(f.render().data, history);
  assert.equal(f.render().error, '');
});

for (const change of ['path', 'revision']) test(`${change} changes discard and abort an old request without disturbing the current result`, async t => {
  const f = fixture(t);
  f.render(change === 'path' ? 'learning?page=2' : undefined, { pollMs: 3000, revision: change === 'revision' ? 1 : 0 });
  assert.equal(f.calls.length, 2);
  const current = { items: [{ id: 'current' }] };
  f.calls[1].resolve(current); await flush();
  f.calls[0].resolve({ items: [{ id: 'stale' }] }); await flush();
  assert.deepEqual(f.render().data, current);
  assert.equal(f.calls[0].signal?.aborted, true);
  t.mock.timers.tick(3000); assert.equal(f.calls.length, 3, 'only the current lifecycle continues polling');
});

test('unmount aborts a pending request and its settlement cannot update state or schedule polls', async t => {
  const f = fixture(t);
  f.unmount();
  f.calls[0].resolve({ items: [] }); await flush();
  t.mock.timers.tick(9000);
  assert.equal(f.writesAfterUnmount(), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal?.aborted, true);
});

test('unmount clears the next poll after a successful request', async t => {
  const f = fixture(t);
  f.calls[0].resolve({ items: [] }); await flush();
  f.unmount();
  t.mock.timers.tick(9000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.writesAfterUnmount(), 0);
});

test('retry is stable, retains displayed data and cancels the replaced request', async t => {
  const f = fixture(t), history = { items: [{ id: 'saved' }] }, retry = f.render().retry;
  assert.equal(typeof retry, 'function');
  f.calls[0].resolve(history); await flush();
  assert.equal(f.render().retry, retry);
  t.mock.timers.tick(3000);
  retry(); f.render();
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.render().data, history);
  f.calls[1].resolve({ items: [{ id: 'stale' }] }); await flush();
  assert.deepEqual(f.render().data, history);
  f.calls[2].resolve({ items: [{ id: 'fresh' }] }); await flush();
  assert.equal(f.render().data.items[0].id, 'fresh');
});

test('a resource without polling can retry a failed initial load', async t => {
  const f = fixture(t, 'items/one/feedback', { pollMs: 0 });
  f.calls[0].reject(new Error('暂时不可用')); await flush();
  assert.equal(f.render().loading, false);
  f.render().retry(); f.render();
  assert.equal(f.calls.length, 2);
  assert.equal(f.render().loading, true);
  assert.equal(f.render().error, '');
  f.calls[1].resolve({ text: '已保存评价' }); await flush();
  assert.equal(f.render().data.text, '已保存评价');
  t.mock.timers.tick(9000); assert.equal(f.calls.length, 2);
});
