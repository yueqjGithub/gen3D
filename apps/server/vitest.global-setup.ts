import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'agent3d-vitest-'));
  process.env.AGENT3D_TEST_DIRECTORY = directory;

  // libSQL 在 Windows 上可能在 worker 退出之前仍持有已关闭数据库的句柄。
  // 等所有测试 worker 退出后再删除本次运行独占的临时目录。
  return async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    delete process.env.AGENT3D_TEST_DIRECTORY;
  };
}
