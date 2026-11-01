/**
 * 凭据仓储的最小写入接口。
 * 具体实现由 Electron 主进程提供，并负责使用系统安全存储保护密钥。
 */
export interface CredentialStore {
  /** 读取 provider 的密钥；未配置时返回 `null`。 */
  get(providerId: string): Promise<string | null>;
  /** 保存或替换 provider 的密钥。 */
  set(providerId: string, secret: string): Promise<void>;
  /** 删除 provider 的已保存密钥。 */
  delete(providerId: string): Promise<void>;
}

/** 只读凭据依赖，供仅需解析模型密钥的服务使用，避免授予写入权限。 */
export type CredentialReader = Pick<CredentialStore, 'get'>;
