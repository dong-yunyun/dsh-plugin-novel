# 导入：先提议，用户确认后才转存

> 诉求：用户把 txt 丢进工作区时，插件应当**提示用户是否触发导入**，而不是直接动文件。
> 结果：`novel_import` 默认只做**提议（dryRun）**，必须显式 `confirm: true` 才写盘。

---

## 一、两段式流程

```
① novel_import({})                    → mode: "proposal"，零写盘
   返回 detectedFiles（作品名/编码/章节数/字数/目标目录）
        askUser（一句可直接转告用户的话）
        willImport（可导入数量）

② 用户确认后
   novel_import({ confirm: true })     → mode: "applied"，真正转存 + 切分
```

工具描述里写死了这条规则：

> 默认只做提议（dryRun），不写盘。先用默认参数调用，把结果报告给用户并询问是否导入；用户明确同意后，再带 `confirm:true` 重新调用。

**为什么把它做进参数而不是靠模型自觉**：这是结构性约束——不带 `confirm` 时物理上写不了盘，模型想跳过确认也跳不过去。

---

## 二、工具参数

| 参数 | 行为 |
|---|---|
| `path` 省略 | 扫描当前会话工作区（浅扫 2 层），找 `*.txt` |
| `path` 给文件 / 目录 | 只处理指定的 |
| `confirm` | **必须显式为 `true` 才写盘**；缺省只返回提议 |
| `move` | 导入后删除原文件（默认 `false`） |
| `force` | 同源已存在时也重导 |

扫描跳过 `novels/`、`releases/`、`dist/`、`node_modules/`、`.git`、`.scale-sim`、`related/`。

---

## 三、提议长什么样

```
mode: "proposal"
willImport: 1
askUser: "检测到 1 个可导入的 txt。是否把它们转存并切分到 <novelsRoot>？确认后我再用 confirm:true 执行。"
detectedFiles: [{ work: "我的小说", chapters: 3, encoding: "UTF-8(BOM)", chars: 120, dest: "..." }]
note: "当前是提议模式，未写入任何文件。"
```

提议阶段会**真的解析一遍**（读字节、判编码、试切分），所以能提前告诉用户"这个文件能切出 3 章"，而不是等确认后才发现不是小说。但解析只读不写。

不是小说的 txt 会在 `detectedFiles` 里标 `status: "not-a-novel"` 并给出原因。

---

## 四、实测

| 场景 | 结果 |
|---|---|
| 提议模式 | `mode: proposal`，`已写盘 = false` |
| 确认后 | `mode: applied`，`我的小说:imported:3`，`已写盘 = true` |
| 幂等 | 同源重复导入返回 `exists`，不重切 |
| 扫描模式 | 两个 txt：新的 `imported`，已存在的 `exists` |

---

## 五、导入后的落盘结构

```
<novelsRoot>/<作品名>/
  source/full.txt      ← 规范化副本（UTF-8 / LF），可追溯
  source/origin.json   ← 原始路径、编码、字节数、sha256、章节数、导入时间
  chapters/ch0001.md …
  manifest.json        ← 切分清单（章号断点、字数、哈希）
```

编码自动识别：UTF-8(BOM) → UTF-8 → GB18030 回退。作品名默认取文件名并清洗非法字符。

导入只做**切分**，不调模型。抽卡片是下一步（`novel_ingest`）。

---

## 六、让"丢文件"能被感知

`novel_status` 的 `pendingTexts` 会列出工作区里有、但尚未导入的 txt：

```json
"pendingTexts": [{ "file": ".../我的小说.txt", "name": "我的小说" }]
```

即使模型没主动扫描，看一眼状态就知道有待处理文件，可以据此发起提议。

---

## 四、路线与配置

`novelsRoot`（默认取 `novelDir` 的父目录）决定新作品放哪：

| 配置 | 效果 |
|---|---|
| `novelDir: 'novels/流氓高手'` | 导入到 `novels/<新作品名>/` |
| `novelsRoot: 'novels'` | 显式指定作品根 |
| 两者都空 | 插件待命 |

导入完成后仍是两步：`novel_ingest` 抽卡片 → 把 `novelDir` 指向新作品目录。

---

## 五、一个实现上的必要调整

切分逻辑原先只在 `src/ingest/split.ts` 里。但**插件跑在宿主进程里，宿主 Node 未必支持类型剥离**，运行时不能依赖 `.ts`。

所以把实现下沉到 `src/core/split.mjs`（纯 JS），`split.ts` 只保留类型声明与 CLI。

改动后重跑等价性验证：**368 章、逐章 sha256 与之前完全一致**。

---

## 六、闸门同步

工具数从 6 变 7，`verify.mjs` 的 `EXPECTED_TOOLS` 已同步加入 `novel_import`。

当前状态：`verify` **9/9 PASS**，发布件 `20261124-131327-80ffab` 已切换生产。
