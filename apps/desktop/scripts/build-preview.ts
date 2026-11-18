import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { modelRuntimeSource } from '../src/renderer/src/features/assets/model-runtime';

/** 一份固定的 iframe HTML，Web/Electron 共用；不用 CDN，不让生成脚本自己拼 HTML。 */
const require = createRequire(import.meta.url);
const viewer = await readFile(new URL('../src/renderer/src/features/assets/preview-frame.js', import.meta.url), 'utf8');
const result = await build({
  stdin: { contents: modelRuntimeSource + '\n' + viewer, resolveDir: dirname(require.resolve('three')), loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife', minify: true,
});
const js = result.outputFiles[0]!.text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src data: blob:; worker-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#cbd2d2}canvas{display:block;width:100%;height:100%}</style>
</head><body><script>${js}</script></body></html>`;
await mkdir(new URL('../generated/', import.meta.url), { recursive: true });
await writeFile(new URL('../generated/model-preview.html', import.meta.url), html);
console.log('Built isolated Three.js preview HTML.');
