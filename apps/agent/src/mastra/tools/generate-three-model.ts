import { transform } from 'esbuild';
import { randomUUID } from 'node:crypto';

/**
 * Agent 只准备脚本，不在服务端启动浏览器、不导出模型文件。
 * 包在函数中做 TS 语法转换，客户端得到的 source 是可执行的 JS 函数体。
 * validation:passed 只表示脚本准备成功；GLB 构建/上传由资产面板明确展示状态。
 */
export async function generateThreeModel(source: string) {
  const compiled = await transform('function buildModel(THREE, sculpt, taper, makeDog) {\n' + source + '\n}', {
    loader: 'ts', target: 'es2022',
  });
  const javascript = compiled.code.slice(compiled.code.indexOf('{') + 1, compiled.code.lastIndexOf('}')).trim();
  return {
    script: JSON.stringify({ format: 'three-script-v1', source: javascript, modelId: randomUUID() }),
    validation: 'passed' as const,
    execution: 'client-required' as const,
  };
}
