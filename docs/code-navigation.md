# 代码导航

> **这不是完整的 LSP。** 是词法层面的符号查找——零依赖、零配置、任何语言可用。

---

## 为什么没做真 LSP

真正的 LSP 要：启动语言服务器进程、实现完整协议栈（initialize、
didOpen、definition、references、documentSymbol）、处理文件同步和位置编码。

工作量很大，而且**每种语言要配一个服务器**（用户机器上未必有）。

而我们真正要解决的问题很具体：

- 这个函数在哪定义的？
- 谁调用了它？
- 这个文件里有什么？

这三个用**结构化文本搜索**就能达到八成效果。剩下的两成（类型推断、
跨模块重导出）等真有痛点再说。

---

## 两个工具

### `find_symbol`

```
find_symbol({ name: "compactMessages", scope: "src" })
```

返回定义位置和所有引用：

```
## compactMessages 的定义（1 处）
- session/compact.ts:145:17  [函数]  export function compactMessages(

## 引用（8 处）
- session/loop.ts:23:10  import { compactMessages, ... } from './compact.js';
- session/loop.ts:114:25 const compacted = compactMessages(messages, compactOptions);
...
```

**和 `search_files` 的区别**：按**标识符边界**匹配。
搜 `foo` 不会命中 `foobar`——这是文本搜索做不到的。

### `list_symbols`

```
list_symbols({ path: "src/components/batches.ts" })
```

列出文件级的函数 / 类 / 接口 / 常量。

---

## 支持的语言

| 语言 | 识别的定义 |
| --- | --- |
| TypeScript / JavaScript | `function` / `const x = () =>` / `class` / `interface` / `type` / 方法 |
| Python | `def` / `class` |
| Rust | `fn` / `struct` / `enum` / `trait` |
| Go | `func` / `type X struct` |

---

## 诚实说明局限

| 能做 | 做不到 |
| --- | --- |
| 找函数/类/变量的声明位置 | 区分同名但不同作用域的符号 |
| 找调用点（按标识符边界） | 跟踪跨文件重导出 |
| 列出文件级符号 | 类型推断、类型诊断 |

工具返回结果里会**明确写出这一点**，不假装是完整语义分析。

---

## 一个真实踩过的坑

`list_symbols` 第一版把 `for (const x of list)` 也当成了定义——
一个文件报了 26 个"符号"，其中 15 个是循环变量。

修法是**不能用缩进判断**（函数体内的声明可能和顶层一样缩进），
改用**大括号深度**：只有深度 0 的声明才算文件级。

修完同一个文件从 26 个降到 11 个，全是真实符号。有测试守着这条。
