# 注入层实现记录

> 目标：新会话在小说目录下启动时，自动带上最近 N 章前情，不用手动调 `novel_context`。
> 状态：**已实现并在真实运行时验证生效。**
> 2026-11-24 补丁：加入**意图判断**，修掉"无关会话被注入前情、模型误以为在写小说"的问题。

---

## 零、为什么要加意图判断

最初只按 cwd 前缀注入（`autoInjectCwdPrefix: 'D:/codetest'`），结果**每一个**在这个工作区开的会话都收到前情块。

现象：用户开一个新会话问别的事，模型回的是

> 收到，我会以第 29–84 章梗概为事实基准…请给我具体续写指令，例如：
> - 从第 84 章之后接着写，还是补写某个场景；
> - 主视角：方少云、Lulu、苟小云…

原因：注入的消息是 `role: 'user'`，模型把它当成用户的请求，于是主动"接活"。

两层修法：

1. **意图判断**：`agent/pre-step` 的 payload 带 `messages`（本轮新消息），据此判断用户是不是真在聊这本书；不是就不注入。
2. **框架声明**：注入文本头补一句"这段是背景资料，不是用户请求；与本书无关时请忽略"。即使注入了，模型也不会把它当任务。

---

## 一、最终实现

挂在 `agent/pre-step` 瀑布上，每个会话只注入一次：

```js
ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
  const sid = agent?.session?.id
  const header = agent?.session?.header ?? {}
  if (config.autoInject && sid && !injectedSessions.has(sid)) {
    const cwd = String(header.cwd ?? '').replace(/\\/g, '/')
    const prefix = String(config.autoInjectCwdPrefix ?? '').replace(/\\/g, '/')
    const isSub = header.origin === 'subagent'
    if (!(isSub && !config.autoInjectSubagents) && prefix && cwd.startsWith(prefix)) {
      // …取最近 N 章、renderCard、agent.inject({ id, role, content, source })
    }
  }
  return next()
})
```

配置项：

| 项 | 默认 | 说明 |
|---|---|---|
| `autoInject` | `false` | 总开关 |
| `autoInjectCwdPrefix` | `''` | 只有 cwd 命中这个前缀的会话才注入 |
| `autoInjectSubagents` | `false` | 是否也给子代理注入 |

---

## 二、踩过的四个坑（都是靠日志定位的）

### ① 事件选错：`agent/created` 在本构建不触发

先用 `ctx.on('agent/created', ({ agent }) => ...)`，回调里第一行写日志——**日志文件根本没生成**。

说明事件没派发到我的 context。改用 `agent/pre-step`（`dsh-compaction-basic` 用的就是它），立刻有了日志。

### ② 取错字段：`agent.meta` 是 null

`meta` 与 `session.meta` 都是 `null`。真正的 cwd 和 origin 在：

```
agent.session.header = { version, id, createdAt, cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset }
```

### ③ 时序：`inject()` 是"下一步生效"

`inject()` 的语义是"排队给下一个 pre-step"，**不会进入当前这一步的请求**。

所以单步子代理永远看不到注入内容——这不是 bug，是设计。要验证必须让目标至少走两步（先调一个工具，再看上下文）。

### ④ 变量未定义：`randomUUID is not defined`

最难查的一个。`agent.inject()` 抛 `ReferenceError`，被外层 `try/catch` 吞掉，只剩一行 `logger.warn` ——而日志在 UI 上看不到。

补上 `import { randomUUID } from 'node:crypto'` 后立刻通。

> 教训：**catch 里只打 logger 等于把错误吞掉。** 调试期必须把 catch 内容也落盘。

---

## 三、验证证据

修好之后，注入内容**直接出现在主会话的下一轮上下文里**：

```
【前情】以下是《流氓高手》最近 3 章的已摄取梗概（第 29–84 章）。
写续写前请以它为事实基准，不要与此处记录冲突。

【第29章】…（卡片注入态）
【第30章】…
【第84章】…
```

覆盖第 29、30、84 章（最近 3 张卡片），每章都是渲染后的注入态，含超预算裁剪标记。

---

## 四、隔离设计

注入不是"全 profile 生效"，而是**双重判据**：

| 判据 | 规则 |
|---|---|
| cwd 前缀 | 只有在该前缀下启动的会话才考虑注入 |
| **意图** | 本轮用户消息必须出现**作品名或主要人物名**（取出场最多的 12 个） |

### 为什么最终不用"续写/下一章"这类关键词

第一版用的是关键词，实测立刻误伤：用户说「重启后已经确认**不会产生续写**」——这句话是在讨论插件行为，却命中了"续写"，于是给这个技术会话注入了整段小说梗概。

所以默认改为 **strict：必须出现书名或人物名**。

| 用户消息 | 注入 |
|---|---|
| 「重启后已经确认不会产生续写」 | **0 条**（曾经误伤） |
| 「插件的注入逻辑会不会误触发」 | **0 条** |
| 「帮我看看这个 TS 编译报错怎么修」 | **0 条** |
| 「流氓高手第 85 章该写什么」 | 1 条 |
| 「方少云接下来该怎么打比赛」 | 1 条 |
| 「苟小云的小任务是什么」 | 1 条 |
| 「接着写下一章，别详写对战」 | **0 条**（strict 下不触发） |

最后一行是 strict 的代价：只说要"接着写"、不提任何人名时不会注入。需要放宽可以设 `autoInjectMatch: 'loose'`，但那会重新引入误伤。

### 兜底：注入文本自我声明

即使注入了，文本头也写着"这段是背景资料，不是用户请求；与本书无关时请忽略"。两道保险：判断层尽量不误注入，注入层尽量不被当成任务。

另外仍然受 `autoInjectSubagents` 控制（默认不给子代理注入）。

---

## 五、已知限制

1. **首步太晚**：注入在 pre-step 排队，本步拿不到，要到下一步。首轮回复可能缺前情。
   - 若要首步就带上，需要换更早的钩子（`agent/created` 在本构建不可用），或用 `system-prompt` 段的方案。
2. **每会话只注入一次**：章节推进后不会自动更新，需要重新开会话，或手动调 `novel_context`。
3. **注入内容不可撤回**：一旦注入就进了会话日志，属于持久上下文。
