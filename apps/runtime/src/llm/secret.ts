/**
 * 密钥加密的客户端（调用桌面壳里的 DPAPI 服务）。
 *
 * ## 为什么绕这一圈
 *
 * DPAPI 是 Win32 API。运行时（Node）要调它就得引原生模块，
 * 会破坏"运行时零第三方依赖"这条底线。
 *
 * 所以：壳（Rust）实现 DPAPI，通过一个只监听回环的 HTTP 端口暴露两个接口，
 * 运行时调用它。连接信息通过环境变量传给自己拉起的子进程——
 * **同机其它程序拿不到那个令牌**，所以不能借用这个服务。
 *
 * ## 没有壳的时候怎么办
 *
 * 直接跑 `node cli.js` 时没有壳，也就没有加密服务。
 * 这时退回明文存储，但会明确提示——**不假装加密**。
 */

export interface SecretCipher {
  readonly available: boolean;
  /** 为什么不可用（展示给用户）。 */
  readonly reason?: string;
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

/** 从环境变量读加密服务地址与令牌（由桌面壳注入）。 */
export function secretServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): SecretCipher | null {
  const url = env.OPENCOXSWAIN_SECRET_URL?.trim();
  const token = env.OPENCOXSWAIN_SECRET_TOKEN?.trim();
  if (!url || !token) return null;

  const call = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(String(json.error ?? `加密服务返回 ${response.status}`));
    }
    return json;
  };

  return {
    available: true,
    async encrypt(plain: string): Promise<string> {
      const json = await call('/encrypt', { plain });
      return String(json.cipher ?? '');
    },
    async decrypt(cipher: string): Promise<string> {
      const json = await call('/decrypt', { cipher });
      return String(json.plain ?? '');
    },
  };
}

/**
 * 判断一个已存的值是不是密文。
 *
 * 用前缀标记，而不是靠"能不能解密"来猜——
 * 猜的成本高，而且失败时的错误很难读懂。
 */
export const CIPHER_PREFIX = 'dpapi:';

export function isCipher(value: string): boolean {
  return value.startsWith(CIPHER_PREFIX);
}
