/**
 * 危险动作识别。
 *
 * 为什么需要：Agent 能直接跑命令、写文件。`rm -rf`、`git push`、发邮件这类动作
 * **不可逆**——一旦执行，用户没有后悔的机会。所以必须在**执行之前**拦下来问一句。
 *
 * 设计原则（比 legacy 更严）：
 *
 * 1. **宁可漏报，不可误伤**。旧实现里 `PAY` 用了 `\bpay\b`，`grep pay`、
 *    `checkout_payment.ts` 这种都会被判成付款并挂起审批——用户会烦到关掉这个功能。
 *    这里收紧成"明确的支付动作"才拦。
 *
 * 2. **只认结构化信号**。只看命令字段，不看文件内容（否则写一个含 "git push"
 *    字样的 README 也会被拦）。
 *
 * 3. **识别不到就放行**。这里不是安全边界，是"提醒用户拍板"的辅助；
 *    真正的安全边界是写域和授权根目录。
 */

export const DANGEROUS_CATEGORIES = ['delete', 'push', 'publish', 'pay', 'external_send'] as const;
export type DangerousCategory = (typeof DANGEROUS_CATEGORIES)[number];

export interface DangerousAction {
  readonly category: DangerousCategory;
  /** 命中的具体证据，直接展示给用户。 */
  readonly evidence: string;
  /** 一句话说明为什么危险。 */
  readonly why: string;
}

const LABELS: Record<DangerousCategory, string> = {
  delete: '删除',
  push: '推送',
  publish: '发布',
  pay: '付款',
  external_send: '对外发送',
};

export function categoryLabel(category: DangerousCategory): string {
  return LABELS[category];
}

/** 只提取可能承载命令的字段，避免把参数内容误判成命令。 */
function commandText(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['command', 'cmd', 'script', 'url']) {
    const value = args[key];
    if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

/**
 * 各分类的判定规则。
 *
 * 每条都用**完整命令形态**而不是单词匹配，避免误伤文件名与普通参数。
 */
const RULES: Array<{
  category: DangerousCategory;
  pattern: RegExp;
  why: string;
  /** 只在命令字段里检查（默认），还是路径字段也检查。 */
  scope: 'command' | 'path';
}> = [
  {
    category: 'push',
    pattern: /\bgit\s+push\b(?!\s*--dry-run)|\bdocker\s+push\b|\bgit\s+force-push\b/i,
    why: '会把本地提交推到远端，其他人会立刻看到，通常不可撤销。',
    scope: 'command',
  },
  {
    category: 'publish',
    pattern:
      /\b(?:npm|pnpm|yarn|cargo)\s+publish\b|\b(?:dotnet|nuget)\s+push\b|\bpip\s+upload\b|\bgh\s+release\s+create\b|\btwine\s+upload\b/i,
    why: '会对外发布版本，一旦发布通常无法撤回。',
    scope: 'command',
  },
  {
    category: 'pay',
    // 收紧：只认明确的支付调用，不要 \bpay\b 这种宽匹配。
    pattern:
      /\bstripe\s+(?:charges?|payments?|refunds?)\s+create\b|\b(?:charge|payment_intent)\s+create\b|\bpaypal\s+\S+\s+(?:charge|payment)\b|\b(alipay|wechatpay)\S*\s+(?:pay|charge)\b/i,
    why: '会产生真实资金流动。',
    scope: 'command',
  },
  {
    category: 'external_send',
    pattern:
      /\bgit\s+send-email\b|\bsendmail\b|\bmailx\b|\bsmtp\b|\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bInvoke-RestMethod\b[^\n]*-Method\s*(?:Post|Put|Patch|Delete)\b|\bInvoke-WebRequest\b[^\n]*-Method\s*(?:Post|Put|Patch|Delete)\b|\bnpm\s+owner\s+add\b/i,
    why: '会把内容发到本机之外，发出去就收不回来。',
    scope: 'command',
  },
  {
    category: 'delete',
    pattern:
      /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)*\S|\bdel\s+|\berase\s+|\brmdir\s+|\bRemove-Item\b|\bgit\s+clean\b|\bgit\s+branch\s+-D\b|\bdrop\s+(?:table|database)\b|\btruncate\s+table\b/i,
    why: '会删除文件或数据，删掉通常找不回来（也不进版本库）。',
    scope: 'command',
  },
];

/**
 * 识别一次工具调用是否属于危险动作。
 *
 * @returns 命中返回分类与证据；不是危险动作返回 null。
 */
export function classifyDanger(tool: string, args: Record<string, unknown>): DangerousAction | null {
  const name = tool.toLowerCase();

  // 工具名本身就能说明问题的（未来若有专用工具）
  if (/(^|[._-])(delete|remove|unlink)([._-]|$)/.test(name)) {
    return { category: 'delete', evidence: tool, why: LABELS.delete + '类工具调用。' };
  }

  const text = commandText(args);
  if (!text.trim()) return null;

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      return {
        category: rule.category,
        evidence: match[0].slice(0, 120),
        why: rule.why,
      };
    }
  }
  return null;
}

/** 动作指纹：用于去重，避免同一条命令反复弹审批。 */
export function actionKey(tool: string, args: Record<string, unknown>): string {
  const normalized = JSON.stringify({ tool, args }, Object.keys({ ...args, tool }).sort());
  return normalized;
}
