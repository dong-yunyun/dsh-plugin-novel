# 正式工作流验证报告

> 日期：2026-11-23 ｜ 范围：插件形态的端到端规则链路 ｜ 结论：**规则段 11/11 通过；模型段未验证（无调用通道）**

## 一、验证方式：跑插件将要跑的那份代码

没有另写一次性脚本，而是把流程收拢成 `src/core/workflow.mjs`，**插件 `index.js` 与验证脚本共用同一份实现**。验证脚本 `scripts/validate-workflow.mjs` 调用的函数，就是插件工具里调用的函数。

```
manifest.json + cards/*.json
        │
        ├─ deriveGraph()    → graph.json      （时序边累积）
        ├─ buildBible()     → bible.json      （人物谱 / 时间线 / 伏笔账本）
        ├─ buildSynopsis()  → synopsis-*.md   （投影，无新增事实）
        ├─ renderCard()     → *.inject.txt    （注入态 + 超预算裁剪）
        └─ runValidation()  → report.json     （枚举 / 悬空引用 / 预算 / 密度交叉检查）
```

## 二、产物清单

| 文件 | 作用 |
|---|---|
| `package.json` | Host bundle 清单，`dsh.bundle.patch` 指向 patch |
| `cordis.patch.yml` | 插入 `novel-helper` 行，含 10 个配置项 |
| `index.js` | 插件入口：`Config` + `apply(ctx, config)`，注册 4 个工具 + 1 个注入钩子 |
| `src/core/workflow.mjs` | 全部纯规则实现（图 / Bible / 概要 / 渲染 / 校验） |
| `scripts/validate-workflow.mjs` | 端到端验证 |
| `locale/{zh,en}.json`、`icon.svg` | 面板显示元数据 |
| `novels/流氓高手/workflow-run/` | 本次运行产物（11 个文件） |

## 三、验证结果

| 检查项 | 值 | 结果 |
|---|---|---|
| 卡片可解析 | 7 | PASS |
| 卡片 schema 违规 | 0 | PASS |
| 图节点数 | 19 | PASS |
| 图边数 | 14 | PASS |
| 图悬空引用 | 0 | PASS |
| 图非法枚举 | 0 | PASS |
| Bible 人物 | 19 | PASS |
| Bible 未回收伏笔 | 11 | PASS |
| 注入超预算章 | 0 | PASS |
| 概要 token | 1,059 | PASS |
| manifest 章号状态 | irregular（已知 4 处断点） | PASS |

注入态实测：180–288 token，全部落在分级预算内。第 84 章触发裁剪（`ext` → `reveals`），符合设计。

## 四、验证过程中抓到并修掉的 3 个缺陷

**① `entities_new.tag` 超 12 字**（ch2、ch84）

我自己的卡片违反了自己定的约束。校验器拦下 → 缩短为「狂热队长·菜鸟」「王绯雨旧友」。

**② 低密度章存储态超预算**（ch3：619 > 450）

根因不是预算错，是 **`density` 打分偏低**。第 3 章有 6 个事件、2 个新实体、1 个物品——按"信息增量"口径该是 0.65，我填了 0.55。

于是给校验器加了一条**交叉检查**：若 `density < 0.6` 且 `beats > 4` 且信息增量项 ≥ 4，判定"density 可能偏低"。这条规则第一次写得太糙（对 ch9 误报），加了"信息增量项 ≥ 4"后精确了——ch9 只有 2 项，不报。

**③ 概要的剧情脉络只取第一条 beat**

投影出来是「外号由来：所有人都叫他流氓」这种，信息量过低。改为取前两条拼接。

## 五、抓到但**没修**的 1 个缺陷（需改 schema）

**伏笔回收匹配不可靠**：概要显示「已回收 0 条」，但 ch4、ch5 明明填了 `foreshadow.paid`。

原因：`planted` 是长描述（"BOS网吧被反复强调，为楚南行出场铺路"），`paid` 是短标签（"BOS高手圈铺垫"），子串匹配失败。

正确修法是给伏笔加 **thread id**：

```json
"foreshadow": {
  "planted": [{ "id": "F-01", "desc": "..." }],
  "paid": [{ "id": "F-01" }]
}
```

这是 schema 2 → 2.1 的改动，等 M6 定稿后一起做，避免又一轮返工。

## 六、安装与运行时验证（已补做）

本机 DSH 是**源码检出 + 独立 profile**，且这一版**没有 `plugin_manager` 工具**（全仓搜索不到该实现），`install_bundle` 不可用。改为按 boot 的真实契约手工安装：

| 步骤 | 动作 |
|---|---|
| 1 | `profiles/desktop/node_modules/dsh-novel-helper` → junction 指向 `D:\codetest\novel-plugin` |
| 2 | profile `package.json` 的 `dsh.profile.bundles` 追加该包名 |
| 3 | 依赖声明 `"dsh-novel-helper": "file:D:/codetest/novel-plugin"` 作为记录 |

依据是 `packages/boot/app-boot/src/profile.ts` 的 `resolveBundleDir()`：**安装锚点优先，其次 profile 目录**，解析走 `require.resolve.paths()` 的 node_modules 链——所以一个 junction 就够，不需要 pnpm、不需要联网。

### 结果：三个工具已在真实运行时跑通

| 调用 | 结果 |
|---|---|
| `novel_status` | 368 章 / 已抽 7 章 / 图 19 节点 14 边 / 各章注入 token 与裁剪记录 |
| `novel_context(84,84)` | 返回带 `[已裁剪]` 标记的注入态，`ext` 与 `reveals` 按策略被丢弃 |
| `novel_synopsis(standard)` | 落盘 `synopses/synopsis-continue-standard.md`，1,059 token / 7 章 |

而且**无需重启**：安装后工具 schema 即时出现在会话工具集里。

### 契约修正记录

第一版 `index.js` 的工具形状是猜的（用了 `schema:`、`execute` 返回任意对象、没有 `output`），装上必然加载失败。按 `packages/core/tools/src/index.ts` 的 `ToolDefinition` 改正为：

```
{ name, description, parameters, output: { schema, render }, execute(args, exec) }
```

`execute` 只返回规范 JSON 值，`output.render(args, value)` 负责投影成 `ContentBlock[]`。

## 七、仍未验证的部分

| 未验证项 | 原因 |
|---|---|
| `ctx.llm.stream()` 逐章抽取 | `novel_ingest` 尚未实现——垂直切片刻意不含模型，先把"能加载、能调用"这条链锁死 |
| `agent.inject()` 注入时机 | 同上，未进切片 |
| `fork`/`resume` 后注入一致性（M8） | 依赖注入层 |

准确说法更新为：**规则段与工具运行时已验证并可用；模型抽取段尚未实现。**

## 八、下一步

1. **补 schema 2.1**：伏笔 thread id（第五节）
2. **实现 `novel_ingest`**：顺序单遍 + `ctx.llm.stream()`，落地后 M6 才能正式验收
3. **加注入层**：`agent/created` + `agent.inject()`，然后验 M8

规则段的回归仍然是一条命令：`node scripts/validate-workflow.mjs`。
