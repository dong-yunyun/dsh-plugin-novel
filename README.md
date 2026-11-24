# 网文续写助手（DSH 插件）

> 把「把整本书塞进上下文」变成「按需注入几百 token 的梗概」，让续写的输入成本与全书字数解耦。

---

## 它解决什么问题

续写一本 100 万字的小说，直接喂原文会撑爆上下文。这个插件做三件事：

1. **离线结构化摄取** —— 逐章抽取成"卡片"（时间/地点/事件/关系变化/伏笔/钩子），存在本地
2. **分层注入** —— 每章只注入 200–300 token 的梗概，而不是几千字原文
3. **闸门** —— 续写前检查主题与前文是否冲突；冲突就拒答并列出依据

## 快速开始

```powershell
# 1. 安装（在 profile 目录下）
pnpm add <tarball 或包名>
# 二选一：加进 profile/package.json 的 dsh.profile.bundles

# 2. 指定作品目录（必填，否则插件待命）
#    编辑 profile/cordis.patch.yml：
#    - id: novel-helper
#      config:
#        novelDir: 'novels/我的小说'   # 相对插件包根，或绝对路径

# 3. 重启 DSH
```

然后让 Agent 帮你跑完整流程：

```
novel_import({})            → 提议：检测到哪些 txt、能切几章（不写盘）
novel_import({ confirm: true }) → 用户确认后转存 + 切分
novel_ingest({ from: 1, to: 30 }) → 逐章抽卡片（会调模型）
novel_continue({ topic: '...' })  → 出续写简报 + 与前文一致性校验
```

## 七个工具

| 工具 | 作用 |
|---|---|
| `novel_import` | 把工作区的 txt 转存并切分（**默认只提议，confirm 才写盘**） |
| `novel_ingest` | 逐章抽取卡片（调模型，可断点续跑） |
| `novel_status` | 摄取进度、图规模、注入预算占用、待导入文件 |
| `novel_context` | 按章范围取渲染好的注入态上下文 |
| `novel_synopsis` | 导出概要（compact / standard / full 三档） |
| `novel_continue` | 续写简报：先校验与前文是否冲突，通过才给指令 |
| `novel_scenes` | 读原文拆场次，供剧本使用 |

## 成本提示

`novel_ingest` **每章一次模型调用**。368 章的书 = 368 次调用。

建议先跑 20–30 章验证效果，再决定是否全书摄取。卡片是增量的，可以随时中断续跑。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `novelDir` | `''` | 作品目录；留空则插件待命、不注册工具 |
| `novelsRoot` | `novelDir` 的父目录 | 新作品导入到哪 |
| `recentChapters` | `3` | 注入时带最近几章 |
| `bibleTokenBudget` | `3000` | 设定集 token 上限 |
| `autoInject` | `false` | 是否在新会话首步自动注入前情 |
| `autoInjectCwdPrefix` | `''` | 只有 cwd 命中该前缀的会话才注入 |
| `chunkChars` | `4000` | 长章切段长度（超长章单次抽取易失败） |

## 已知限制

- **只在 Windows 上验证过**。Linux/macOS 未实测。
- **长章分段抽取**只在离线单测验证过，未在真实运行时跑过全书。
- **内容过滤是兜底而非保险**：主判据是抽取时的内容判断；随包不发布词表，产物扫描需自行配置。
- **不做全书→剧本**：剧本只针对单个叙事单元（约 100 章内）。
- 卡片质量受模型影响；同一章反复抽取可能得到不同结果。

## 许可

MIT
