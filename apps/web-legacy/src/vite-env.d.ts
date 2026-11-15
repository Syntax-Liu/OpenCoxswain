/**
 * Vite 的 `?raw` 导入：把文件内容当字符串引入。
 *
 * 图标 SVG 要内联进 DOM（见 AppIcon），所以用 `?raw` 拿原文，
 * 而不是 `?url` 拿一个重新发请求的地址。
 */
declare module '*.svg?raw' {
  const content: string;
  export default content;
}
