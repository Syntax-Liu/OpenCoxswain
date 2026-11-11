import { useEffect, useState } from 'react';

import type { ApiClient, UpdateCheckDto } from '../api.js';

/**
 * 更新提示条。
 *
 * 三条原则：
 * 1. **没查过就不显示**——绝大多数用户不关心，不要拿一条常驻横幅骚扰人；
 * 2. **有新版也只提示，不自动下载**——下载与替换是不可逆的，必须用户点；
 * 3. **失败安静**——离线、接口挂了都不该弹错误，更新不是关键路径。
 */
export function UpdateBanner({
  api,
  refreshKey,
}: {
  api: ApiClient;
  /** 变化时重新拉取（例如设置页关闭后）。 */
  refreshKey?: number;
}): JSX.Element | null {
  const [check, setCheck] = useState<UpdateCheckDto | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .update()
      .then((r) => {
        if (!cancelled) setCheck(r.check);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, refreshKey]);

  if (!check || !check.available || dismissed) return null;

  return (
    <div className="update-banner" role="status">
      <span className="update-icon">↑</span>
      <span>
        有新版本 <strong>{check.version}</strong>
        <span className="muted small">（当前 {check.currentVersion}）</span>
      </span>
      <span className="update-line">
        安装包在
        <a
          href="https://github.com/Syntax-Liu/OpenCoxswain/releases/latest"
          target="_blank"
          rel="noreferrer"
        >
          GitHub Releases
        </a>
      </span>
      <button type="button" className="link" onClick={() => setDismissed(true)}>
        知道了
      </button>
    </div>
  );
}
