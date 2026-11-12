/**
 * 本机访问令牌。
 *
 * ## 为什么需要
 *
 * 运行时只监听 `127.0.0.1`，但**同机上的任何程序都能访问它**：
 * 任何网页、任何脚本、任何别的应用。而 API 能派活、能跑命令、能读写你的文件。
 *
 * 更糟的是原来的 CORS 是 `*`——意味着你在浏览器里打开一个恶意网页，
 * 它就能跨源读走你的项目列表、会话记录、审批内容，甚至派活执行命令。
 *
 * ## 做法
 *
 * - 首次启动生成一个随机令牌，存到 `~/.opencoxswain/token`（仅本机可读）；
 * - API 请求必须带 `Authorization: Bearer <token>`；
 * - **静态资源（界面本身）不需要令牌**——否则界面加载不了，
 *   令牌通过首屏注入递给前端。
 *
 * ## 不做什么
 *
 * 不做"多用户/权限分级"。这是一个本地单用户工具，
 * 令牌的作用只是**把"同机任意程序"缩小到"知道令牌的程序"**。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 令牌长度（字节）。32 字节 = 256 位，足够。 */
const TOKEN_BYTES = 32;

export interface TokenStoreOptions {
  /** 令牌文件路径。 */
  readonly file: string;
}

export class TokenStore {
  constructor(private readonly options: TokenStoreOptions) {}

  get file(): string {
    return this.options.file;
  }

  /**
   * 读令牌；不存在就生成一个。
   *
   * 也支持用环境变量覆盖（自动化测试与 CI 用）。
   */
  async resolve(): Promise<string> {
    const fromEnv = process.env.OPENCOXSWAIN_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    const existing = await this.read();
    if (existing) return existing;

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    await mkdir(path.dirname(this.options.file), { recursive: true });
    // 0600：只有当前用户能读。
    await writeFile(this.options.file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    return token;
  }

  async read(): Promise<string | null> {
    try {
      const raw = (await readFile(this.options.file, 'utf8')).trim();
      return raw.length >= 16 ? raw : null;
    } catch {
      return null;
    }
  }
}

/**
 * 校验请求头里的令牌。
 *
 * 用**定时安全比较**：虽然本地场景下计时攻击不现实，
 * 但令牌比较本该这样写，没有理由写错。
 */
export function isAuthorized(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  return timingSafeEqualStr(match[1], expected);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i]! ^ bufB[i]!;
  return diff === 0;
}

/**
 * 判断某个来源是否允许跨源访问。
 *
 * 只放行本地界面自己的来源。其余一律不放行——
 * 这正是挡掉"恶意网页读本地 API"的关键。
 */
export function isAllowedOrigin(origin: string | undefined, selfPorts: readonly number[]): boolean {
  if (!origin) return true; // 非浏览器请求（curl / 桌面壳）不带 Origin
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname;
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLocal) return false;

  // 端口必须是我们自己监听的端口之一。
  const port = parsed.port ? Number(parsed.port) : 80;
  return selfPorts.includes(port);
}
