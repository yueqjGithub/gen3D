/**
 * SQLite 方法直接返回值，PostgreSQL 方法通过网络异步返回。
 * 路由统一 await 两者，不需要再包装一层运行时代理，也不改变请求或响应的数据结构。
 * 这个类型只将方法的返回值放宽为“原值或 Promise”；实际实现仍在对应仓库文件里。
 */
export type Repository<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>>
    : T[K];
};
