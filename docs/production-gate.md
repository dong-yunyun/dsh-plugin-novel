# 生产准入闸门（pre-production gate）

## 为什么要有这个东西

DSH 加载插件的方式是：profile 里的 `node_modules/dsh-novel-helper` 是一个**目录联接**，
原先直接指向开发目录 `.\novel-plugin`。

后果：**保存即上线**。编辑器里改错一个字符，DSH 下次启动就加载不了插件，直接起不来；
而你在编辑器里看到的永远是"文件已保存"，没有任何提示告诉你此刻生产已经坏了。

2026-11-24 01:56 就是这么坏的一次：

```
ReferenceError: randomUUID is not defined
    at file:///index.js:534
```

`index.js` 里用了 `randomUUID()`，但 `import { randomUUID } from 'node:crypto'` 那行没写。
`node --check` 语法检查是**通过**的——语法没错，是运行到那行才炸。所以：

> 语法检查不能当准入闸门。闸门必须把插件真的跑一遍。

## 闸门做了什么

`scripts/verify.mjs` 有 9 项检查，任何一项不过就不允许发布：

| 检查 | 抓什么 |
|---|---|
| `pkg/manifest` | `files` 声明了不存在的文件、`exports`/`dsh.bundle.patch` 指向错误、发布件被人手改（哈希对不上） |
| `pkg/modules` | 模块导入失败（含语法错、链接错、`export` 名字对不上）、裸包名/绝对路径依赖（发布件里没有 node_modules） |
| `entry/contract` | `apply` / `inject` 导出的形态 |
| `activation` | 用**生产真实配置**激活插件，必须注册齐 6 个工具，且没有 novelDir 时安静待命 |
| `data/readable` | 生产 manifest / 章节 / 卡片能读，卡片 JSON 没坏 |
| `tools/read-only` | 真数据上跑 `novel_status`、`novel_context` |
| `tools/write-paths` | 临时数据上跑 `novel_ingest`、`novel_scenes`、`novel_continue`、`novel_synopsis`（假模型，不烧 token） |
| `tools/conformance` | 工具名、`parameters` schema、`required` 字段、`output.render` 真能产出 `{type:"text"}` |
| `hook/pre-step` | 前情注入：注入 1 条、同会话不重复、cwd 不匹配不注入、钩子抛错也要 `next()` |

## 严格度：没有"宽松模式"

生产只有一档，全绿才放行，任何一项失败都阻断，不存在 `--skip`、`--force` 之类的口子。
其中数据侧（`data/readable`）是**硬失败**，不是警告：

- `manifest.json` 里每一章的 `sha256` 必须与 `chapters/` 下文件的实际哈希一致（368 章逐个算，约 20ms）
- 章号、文件必须一一对应，缺一个就拒绝
- 每张卡片必须由**被测包自己的** `validateCard()` 校验通过：beats ≤6、枚举合法、密度与预算不超限
- 卡片文件名里的章号必须与 `card.chapter` 一致，章号不许重复

换句话说：**数据坏了，代码再好也不许上线**。

「验生产」也做了防自欺：`verify --pkg prod` 会先确认生产联接不是开发目录，
否则直接报错退出——否则你验的其实是开发目录。

第 9 项就是抓那次事故的检查项：钩子内部有 `try/catch`，`randomUUID` 未定义时异常被吞成一条
warn 日志、注入静默失败。闸门会把插件自己的日志一起打出来，所以报错长这样：

```
FAIL hook/pre-step  首步应注入 1 条前情，实际 0 条；插件日志：注入失败：randomUUID is not defined
```

## 命令

```powershell
# 1) 只验证，不改任何东西
scripts\np.cmd verify

# 2) 验证 + 冻结发布件（仍不改生产）
scripts\np.cmd publish

# 3) 验证 + 冻结 + 切换生产（需要重启 DSH 生效）
scripts\np.cmd publish --apply --note "what changed"

# 生产现在指向谁（被 pnpm install 绕过时会报警）
scripts\np.cmd status

# 出事了，切回上一个发布件
scripts\np.cmd rollback
scripts\np.cmd rollback --list

# 闸门自测：证明它拦得住上次那类事故、且不误报
scripts\np.cmd gate:selftest
```

`np.cmd` 会先找 PATH 里的 node，找不到就用 DSH 自带的运行时，所以不用配环境变量。
`--note` 写英文短句即可（终端编码不一时中文容易变乱码，不影响发布本身）。

## 目录结构

```
            ← 开发目录，随你怎么改，DSH 不再加载它
├─ releases\
│  ├─ index.json                     ← 发布记录（含 prev，回滚就是靠它）
│  ├─ 20261124-0230-ab12cd\          ← 不可变发布件，只有 verify 全过才会被创建
│  │  ├─ release.json                ← 每个文件的 sha256，之后谁手改都能查出来
│  │  ├─ index.js  package.json  cordis.patch.yml  icon.svg
│  │  ├─ src\  locale\
│  └─ ...（最多保留 5 个，当前在用的永不清理）
└─ scripts\{verify,publish,rollback}.mjs
```

生产联接：

```
~\.dsh\profiles\desktop\node_modules\@local\dsh-novel-helper
  → releases\<id>     ✔ 只有验证过的代码会到这里
```

## 发布流程做了什么（`publish.mjs`）

1. `verify` 开发目录 → 不过就退出，**不产生任何发布件**。
2. 按 `package.json` 的 `files` 复制成 `releases\<时间戳>-<index.js 前 6 位哈希>`，写 `release.json`（逐文件 sha256）。
3. **对发布件再验一遍** → 抓"`files` 漏了文件"这类只在发布后才会暴露的问题；不过就删掉该发布件。
4. `--apply` 时才切换联接；切换后立刻 `realpath` 校验，失败自动切回原目标，绝不留下悬空联接。

只有第 4 步会写 workspace 之外（profile 的 node_modules），其余全程在 `.` 内。

## 回滚

```powershell
scripts\np.cmd rollback          # 回到上一个
scripts\np.cmd rollback --list   # 看有哪些
scripts\np.cmd rollback 20261124-0230-ab12cd
```

回滚刻意**不做完整验证**——新发布件已经让 DSH 起不来的时候，不能再让闸门拦着救火。
只保证两件事：目标是带 `release.json` 的发布件（不是开发目录）、目标 `index.js` 能导入。

## 一个需要知道的坑

如果哪天重新执行了 `pnpm install`（或 DSH 自己重装 profile），pnpm 可能把
`node_modules/dsh-novel-helper` 重新指回开发目录——闸门就被绕过了。

```powershell
scripts\np.cmd status
```

输出 `⚠ 仍指向开发目录` 就说明被绕过了，重跑一次 `publish --apply` 即可复原。

## 日常姿势

1. 在 `.\novel-plugin` 里改代码，随便改、随便存，DSH 不受影响。
2. 改完 `scripts\np.cmd verify`，红了你就在自己的开发目录里修，不会波及生产。
3. 绿了 `scripts\np.cmd publish --apply --note "……"`，重启 DSH。
4. 重启出问题 `scripts\np.cmd rollback`，重启回来。
