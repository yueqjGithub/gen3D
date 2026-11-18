import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// 容器内仍是两个普通 Node 进程。tini 负责回收子进程；本文件只转发退出信号。
// 任意一个后端退出，停止另一个并让容器失败退出，避免留下半可用的站点。
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
let remaining = 0;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  // SSE 等待中的连接也不能无限阻塞部署停止。仅终止本容器创建的两个进程。
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }, 10000).unref();
}
function launch(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
  children.push(child); remaining++;
  child.on('error', () => stop(1));
  child.on('exit', code => { stop(code || 1); if (--remaining === 0) process.exit(process.exitCode || 0); });
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

launch(['.mastra/output/index.mjs'], root + '/apps/agent');
let ready = false;
for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
  ready = await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: 62687 });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  if (ready) break;
  await delay(200);
}
if (!ready) stop(1);
else if (!stopping) launch(['apps/server/dist/index.js'], root);
