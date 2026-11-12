/**
 * 错误分类与展示。
 *
 * ## 为什么需要
 *
 * 现在错误是底部的一行红字 toast，几秒后被顶掉。用户看到"出错了"，
 * 但不知道：
 * - 是**我能解决的**（改个设置就好）
 * - 是**它在自己重试的**（等等就行）
 * - 还是**必须我做决定的**（它卡住了，等你）
 *
 * ## 三类的区别在于「谁该动」
 *
 * | 类 | 谁该动 | 界面表现 |
 * | --- | --- | --- |
 * | self-recoverable | **它自己** | 灰调，说明"它会自己换法重试" |
 * | needs-user | **你** | 琥珀，说明"需要你决定" |
 * | environment | **没人，得先修环境** | 红调，给出具体修复建议 |
 *
 * 这个分类和 `executor/executor.ts` 的 `BlockKind` 是同一套语义——
 * 那边给 Agent 看（决定要不要重试），这边给用户看（决定要不要管）。
 *
 * ## 一个刻意的做法：错误不自动消失
 *
 * 错误是**事实**，不是提示。提示可以自己消失，事实不该。
 * 用户可以主动关掉，但不会被"顺手抹掉"。
 */

export type ErrorKind = 'self-recoverable' | 'needs-user' | 'environment';

export interface ClassifiedError {
  readonly kind: ErrorKind;
  /** 一句标题：发生了什么。 */
  readonly title: string;
  /** 谁该做什么。 */
  readonly action: string;
  /** 原始信息（可折叠展示）。 */
  readonly detail: string;
  /** 界面用的色调。 */
  readonly tone: 'muted' | 'warn' | 'danger';
}

/**
 * 根据错误文本分类。
 *
 * 规则与 Agent 侧的 `classifyBlock` 保持一致——两边看同一类问题得出
 * 同一个结论，否则会出现"它以为能自己修、界面却让你去处理"的错位。
 */
export function classifyError(message: string): ClassifiedError {
  const text = (message ?? '').toLowerCase();

  // 环境问题：缺依赖、没权限、连不上、端口占用、路径不对
  if (
    /enoent|command not found|不是内部或外部命令|permission denied|eacces|eperm|no such file or directory|enospc|disk full|eaddrinuse|port .* in use|econnrefused|etimedout|network|fetch failed|连不上|没有权限|无法访问|目录不存在|不是一个目录|路径.*不存在/.test(
      text,
    )
  ) {
    // 路径类的和依赖类的问题，修法不一样，分开说
    const isPath = /目录不存在|不是一个目录|路径.*不存在|no such file or directory|enoent/.test(text);
    return {
      kind: 'environment',
      title: isPath ? '这个路径用不了' : '环境有问题，它自己解决不了',
      action: isPath
        ? '检查路径是否写对了、目录是否存在。改好后重新打开。'
        : '按下面的提示修一下环境，然后重新发一次。这类问题重试没用。',
      detail: message,
      tone: 'danger',
    };
  }

  // 模型/网络侧的临时问题
  if (/rate limit|429|timeout|超时|overloaded|503|502|500/.test(text)) {
    return {
      kind: 'self-recoverable',
      title: '模型服务暂时没响应',
      action: '通常是临时的，再发一次通常就好。连续失败再检查网络或额度。',
      detail: message,
      tone: 'muted',
    };
  }

  // 密钥/配置问题：必须用户动手
  if (/api key|api密钥|未配置|unauthorized|401|403|invalid.*key|密钥/.test(text)) {
    return {
      kind: 'needs-user',
      title: '模型密钥有问题',
      action: '打开设置（Ctrl+,）检查模型配置和密钥，然后重试。',
      detail: message,
      tone: 'warn',
    };
  }

  // 需要人拍板
  if (/需要你|需要用户|卡住|blocked|等待批准|waiting for approval|未获批准/.test(text)) {
    return {
      kind: 'needs-user',
      title: '它卡住了，在等你决定',
      action: '看下面的说明，给它一个明确的答复。',
      detail: message,
      tone: 'warn',
    };
  }

  // 默认：当成需要人看一眼
  return {
    kind: 'needs-user',
    title: '出错了',
    action: '看下面的原始信息。如果是它在重试，等一会儿；否则可能需要你处理。',
    detail: message,
    tone: 'warn',
  };
}

/** 三类各自的短标签（状态栏/徽标用）。 */
export const ERROR_KIND_LABEL: Record<ErrorKind, string> = {
  'self-recoverable': '自动重试',
  'needs-user': '需要你',
  environment: '环境问题',
};
