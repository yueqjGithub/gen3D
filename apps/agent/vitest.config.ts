import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 仅进程 worker 支持在配置回归测试中模拟 Mastra 子进程的工作目录。
    pool: 'forks',
  },
});
