# PowerShell → TypeScript 迁移记录

> 目标：去掉 `.ps1`，让摄取工具链在任何装了 Node 的平台上都能跑。
> 结果：**三个脚本全部迁完，切分器逐章 sha256 与 PowerShell 版完全一致。**

---

## 一、为什么可以不带编译步骤

Node 24 内置类型剥离（`process.features.typescript === 'strip'`），`.ts` 可直接 `node xxx.ts` 执行。

代价是只能用**类型注解**，不能用 `enum` / `namespace` / 参数属性这类需要代码生成的语法。三个脚本都遵守了这一点。

对使用方的要求：

| Node 版本 | 可用性 |
|---|---|
| ≥ 24 | 直接运行 |
| 22.6 – 23 | 需要 `--experimental-strip-types` |
| < 22.6 | 不可用，需自行 tsc 编译 |

这条限制写在每个文件头部，避免有人拿老版本 Node 跑不通还找不到原因。

---

## 二、三个脚本

| 原文件 | 新文件 | 状态 |
|---|---|---|
| `src/ingest/split.ps1` | `src/ingest/split.ts` | 生产路径 |
| `src/ingest/render.ps1` | `src/ingest/render.ts` | 生产路径（渲染逻辑仍复用 `workflow.mjs`，不重复实现） |
| `src/ingest/nodes.ps1` | `src/ingest/nodes.ts` | **仅诊断**，头部写明召回率 6.8% 的结论 |

三个都导出了纯函数（`splitNovel` / `renderDirectory` / `scanDirectory`），可以直接单测，不再只能整脚本跑。

---

## 三、等价性验证

用真实语料跑 TS 版切分器，与 PowerShell 版逐章比对：

| 项 | PowerShell | TypeScript |
|---|---|---|
| 编码识别 | GB18030 | GB18030 |
| 章节数 | 368 | 368 |
| 总字数 | 1,176,641 | 1,176,641 |
| 章号断点 | 4 | 4（位置/类型完全一致） |
| 被拒标题 | 1（L3265） | 1（L3265） |
| **逐章 sha256** | — | **368/368 一致** |

渲染器：31 张卡片、7,967 token、0 章超预算，与迁移前一致。

节点扫描器：281 个候选（旧版 262，差异来自正则与停用词微调），关键指标一致——方少云仍然只有 888 次命中，而它全文出现 13,127 次。

---

## 四、顺带修掉的一个真问题

跑你的 `verify` 时，`hook/pre-step` 报「首步应注入 1 条前情，实际 0 条」。

根因两层：

1. **实现过严**：注入守卫要求 `agent.session.header.cwd` 存在且命中前缀。契约 fixture 里没有 cwd，于是直接判不匹配。
   → 改成**cwd 缺失视为"未知"**，不因此拒绝；只有 cwd 已知且不匹配时才跳过。
2. **前缀配错**：我上一轮为隔离把前缀收窄成 `D:/codetest/novel-plugin`，而 fixture 用 `D:/codetest`。
   → 改回工作区根目录。

修完 `verify` 9/9 通过，`gate:selftest` 也通过（闸门能拦住历史事故 `randomUUID is not defined`，且不误报干净代码）。

---

## 五、用法

```powershell
# 切分
node src/ingest/split.ts --source <原文.txt> --workdir <输出目录> [--name 作品名]

# 渲染
node src/ingest/render.ts --cards <cards 目录>

# 节点扫描（诊断）
node src/ingest/nodes.ts --chapters <chapters 目录> --out nodes.json
```

也挂进了 package.json：

```powershell
node -e "0" ; npm run ingest:split -- --source ... --workdir ...
npm run ingest:render -- --cards ...
npm run ingest:nodes -- --chapters ... --out ...
```

---

## 六、发布状态

| 项 | 值 |
|---|---|
| 发布件 | `20261124-025249-9ae9b6` |
| 生产联接 | `profiles/desktop/node_modules/dsh-novel-helper` |
| 准入验证 | 9/9 PASS |
| 回滚 | `node scripts/rollback.mjs` |

**生效需要重启 DSH**（发布件是目录级切换，运行中的进程仍持有旧模块）。
