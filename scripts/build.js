import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/client.jsx'], bundle: true, format: 'cjs', platform: 'browser', jsx: 'transform', loader: { '.css':'text' }, external: ['react', 'react-dom'], write: false });
await mkdir('dist', { recursive: true });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({
  id: 'dsh-message-console',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    ${result.outputFiles[0].text}
    return module.exports;
  }
});\n`);
