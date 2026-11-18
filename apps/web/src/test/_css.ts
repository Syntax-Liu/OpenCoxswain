/**
 * 测试用的样式读取入口。
 *
 * ## 为什么需要这个文件
 *
 * 控件层拆分后，样式分布在两个文件：
 * - `styles.css`  历史遗留（各场景类、一次性样式）
 * - `ui.css`      **控件层契约**（Button / ListItem / Field / OptionItem）
 *
 * 31 个测试原本各自 `readFileSync('styles.css')`。拆完之后，
 * 断言控件规格的测试全部失败——它们读不到契约层了。
 *
 * 与其改 31 处（而且下次再拆文件还要改 31 处），
 * 不如让所有测试都从这里读。
 *
 * ## 注意：路径按**源码目录**算，不是编译产物目录
 *
 * `tsc` 把测试编译到 `dist-test/test/`，但 `.css` 不会跟着复制过去。
 * 所以这里用 `process.cwd()`（pnpm 在 `apps/web` 下跑测试）
 * 定位到 `src/`，而不是 `import.meta.url` 的相对路径。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

const styles = readFileSync(join(SRC, 'styles.css'), 'utf8');
const ui = readFileSync(join(SRC, 'ui.css'), 'utf8');

/** 拼接后的全部样式。顺序与 main.tsx 的导入顺序一致。 */
export const allCss = `${styles}\n${ui}`;

/** 只有历史遗留部分（极少情况下需要区分）。 */
export const legacyCss = styles;

/** 只有控件层契约（极少情况下需要区分）。 */
export const uiCss = ui;
