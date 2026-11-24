# 路径可移植性整改

> 诉求：**插件自身位置的路径不能硬编码**，尤其是日志/DFX 这类运行时路径；固定业务路径（如作品目录）可以保留。

---

## 一、整改前的状况

| 位置 | 问题 |
|---|---|
| `scripts/*.mjs`（6 个） | 顶部写死 `const WORK = 'D:/codetest/novel-plugin/novels/流氓高手'` |
| `scripts/scene-diff.mjs` | 另有两处写死 `reference/` 与输出路径 |
| `scripts/scan-content.mjs` | 词表路径写死 |
| `cordis.patch.yml` | `novelDir` 写死绝对路径，换机器就找不到 |
| `scripts/mock-dsh.mjs` | 默认 `cwd` 写死 `D:/codetest` |

---

## 二、整改方式

### ① 新增 `scripts/lib/paths.mjs`：一切从自身位置推导

```js
export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WORK_DIR = process.env.NOVEL_WORK ?? discoverWork()
export const TERMS_FILE = process.env.NOVEL_TERMS ?? join(PKG_DIR, 'sanitize', 'terms.txt')
export const REFERENCE_DIR = join(PKG_DIR, 'reference')
```

`discoverWork()` 在 `novels/` 下找**同时含 `manifest.json` 与 `cards/`** 的目录，并跳过 `_` / `.` 开头的临时目录。

覆盖方式：`NOVEL_WORK=... NOVEL_TERMS=...`，便于 CI 或别的机器。

### ② 插件入口：`novelDir` 不再绑定具体作品

出厂配置改成留空：

```yaml
novelDir: ''   # 必填：作品目录。填相对插件包根的路径（如 novels/我的小说）或绝对路径；留空则插件待命
```

三种语义：

| 写法 | 行为 |
|---|---|
| 相对路径（`novels/我的小说`） | 相对插件包根解析，跨机器可移植 |
| 绝对路径（`D:/.../novels/xxx`） | 原样使用，用户 patch 层的常见写法 |
| **留空** | **插件待命，不注册任何工具** |

**留空为什么是待命而不是自动发现**：我先试过"留空则在 `novels/` 下自动发现恰好一部作品"，但生产闸门的 `activation` 契约明确要求「novelDir 未配置时不应注册任何工具」，两者冲突。按闸门为准——它才是生产准入的判据。

对使用者的含义：**新用户放入自己的小说后，需要在 patch 里把 `novelDir` 指到那个目录**。这是有意的显式配置，避免插件自作主张猜作品。

### ③ DFX / 日志路径

排查结果：**插件代码里已经没有任何硬编码的日志路径**。调试期的 `debug-inject.log` 在定位完 `randomUUID` 那个 bug 后已移除，异常现在只走 `ctx.logger.warn`。

### ④ mock 默认值

`scripts/lib/mock-dsh.mjs` 的默认 `cwd` 从 `'D:/codetest'` 改为 `process.cwd()`。

---

## 三、整改后扫描结果

```
src/ 与 index.js 中的绝对路径：无（全部由 import.meta.url 推导）
运行时代码中的硬编码日志路径：无
```

仍存在的绝对路径只有两类，都不属于"插件自身位置"：

| 位置 | 性质 | 处理 |
|---|---|---|
| `scripts/verify.mjs` 的 `cwd: 'D:/codetest'` / `'D:/somewhere-else'` | **闸门 fixture**，用于验证"命中前缀才注入 / 不命中不注入" | 保留。它是测试输入，不是运行时路径 |
| profile 的 `cordis.patch.yml`（用户层） | 业务路径，按你说的"固定可以保留" | 保留 |

---

## 四、验证

| 检查 | 结果 |
|---|---|
| 6 个脚本全部可运行 | ✅ 退出码 0 |
| 相对 `novelDir` 解析 | ✅ `novels/流氓高手` → 6 个工具正常注册 |
| `verify` 生产准入 | ✅ 9/9 PASS |
| `gate:selftest` | ✅ 通过（能拦历史事故、不误报） |

新发布件：`20261124-130637-981f14`，已切换生产。

---

## 五、一个失误记录

改 `mock-dsh.mjs` 时用了错误的路径（真正文件在 `scripts/lib/`），`Get-Content` 读空后直接 `WriteAllText(path, null)`，**把一个不存在的路径创建成了 0 字节文件**。

影响：`scripts/mock-dsh.mjs` 多出一个空文件，真正的 `scripts/lib/mock-dsh.mjs`（7,294 字节）未受影响，`verify` 仍 9/9。已删除该空文件。

教训：`WriteAllText` 收到 `null` 不会报错，只会把文件清空/创建为空。写文件前必须先校验内容非空。
