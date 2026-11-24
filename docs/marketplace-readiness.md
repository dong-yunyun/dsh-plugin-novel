# 上架就绪度评估

> 问题：现在这个插件能打包上传市场了吗？
> **答：能打包、能安装，但还不能公开上架。缺的不是功能，是"包外"的东西。**

---

## 一、先澄清一件事

**这个 DSH 构建没有插件市场。**

我在源码里找过：只有 `ui-settings-plugin-inventory`（只读的插件清单页）和 `host/plugin-inventory`（把 Loader 条目投影给 UI）。**没有商店、没有安装 UI、没有 registry 客户端**，也没有 `plugin_manager` 工具。

所以"上传市场"实际只有一条路：**发到 npm，用户 `pnpm add` 后加进 `dsh.profile.bundles`。**

---

## 二、已经达标的

| 维度 | 状态 |
|---|---|
| 打包 | ✅ tarball 28 KB → 12 个文件（含 README/LICENSE） |
| 安装 | ✅ 干净目录 pnpm 装、隔离 profile 装都验过 |
| boot 解析 | ✅ 复刻 `resolveBundleDir()` 走通 |
| 加载 | ✅ 7 个工具注册，数据可读 |
| 契约 | ✅ 空 novelDir 待命（0 工具） |
| 准入闸门 | ✅ 9/9 PASS（含冻结件复验） |
| 规模 | ✅ 368 章 / 117 万字，规则链路 72ms |
| 文档 | ✅ README / LICENSE / 12 篇设计文档 |

---

## 三、上架前的硬阻塞（4 项）

### ① `"private": true` —— 直接禁止 npm publish

npm 会拒绝发布 `private: true` 的包。要发就得改 `false`（或删掉这个字段）。

> **✅ 已修复**：改为 `false`。

### ② `@local/` 这个 scope 不是你能发布的

原来的 `@local/dsh-novel-helper` 只能在本地影射，公开 npm 发不了。

> **✅ 已修复**：改名为无 scope 的 **`dsh-novel-helper`**（npm 上未被占用，登记表返回 404）。
>
> 连带更新：`cordis.patch.yml` 的 `name`、profile 的 `bundles`、`verify.mjs` 的名称断言与 `PROD_LINK`、8 篇文档。
> 旧 `@local` junction 已删除，新 junction 指向 `releases/20261124-151252-884039`。
> 版本升到 **0.2.0**（改名属于破坏性变更）。
>
> 复刻 boot 解析验证：profile 能解析到 `dsh-novel-helper@0.2.0`，patch 名称正确，7 个工具正常加载。

### ③ 缺 npm 页面要的元数据

| 字段 | 现状 |
|---|---|
| `license` | ✅ 已补 MIT |
| `README.md` | ✅ 已补 |
| `LICENSE` | ✅ 已补 |
| `repository` | ❌ 没有仓库地址 |
| `homepage` | ❌ 没有 |
| `author` | ❌ 没有 |
| `engines` | ✅ 已补 `node >= 22.6` |

后三项需要你提供真实信息，**我不该编造**。

### ④ 首次安装的体验是"插件坏了"

出厂 `novelDir: ''` → **一个工具都不注册**。这是生产闸门要求的契约（未配置即待命），但对新用户来说：装完、重启、看不到任何 `novel_*` 工具，第一反应是"装失败了"。

README 里已写清"必填 novelDir，否则插件待命"，但工具层面仍无信号。

---

## 四、功能层面的实质风险（3 项）

### ① 长章分段抽取没在真实运行时验证过

`splitForExtraction` + `mergePartCards` 只做了离线单测（ch84 切 2 段、合并去重都对）。真实会话里还没跑过一次长章抽取。

这是**最该补的一枪**：拿 ch84 重抽一次，确认不再失败。

### ② 只在 Windows 验证过

Linux / macOS 完全没测。已知的两个潜在差异：

- `TextDecoder('gb18030')` 依赖 ICU 数据，small-icu 的 Node 构建会失败
- 路径大小写敏感性（`startsWith(PKG_DIR)` 在 Linux 上严格区分大小写）

### ③ 成本没有内置提示

368 章 = 368 次模型调用。README 写了，但用户真跑 `novel_ingest` 时工具不预估花费。存在 `estimate` 能力（返回 `estimate` 字段），但没算 token/费用。

---

## 五、结论

| 目标 | 现在能不能 |
|---|---|
| 给同事/自己机器安装 | ✅ **能**，tarball + pnpm add 已验证 |
| 内网/私有 registry 分发 | ✅ **能**，只要 scope 改成你们的 |
| 公开 npm 上架 | ❌ **不能**，卡在 `private: true` + `@local` scope + 缺元数据 |
| 功能可信度 | ⚠️ **大体可信**，但长章分段与跨平台两块没验证 |

**建议顺序**：先补长章分段那一次真实验证（成本最低、风险最高），再决定 scope 与是否公开。元数据和改名都是机械工作，随时能做。

---

## 六、本轮已做

- 新增 `README.md`（含快速开始、七个工具、成本提示、已知限制）
- 新增 `LICENSE`（MIT）
- `package.json` 补 `license` / `keywords` / `engines`，`files` 加入 README 与 LICENSE
- 重新打包：12 个文件，`verify` 仍 9/9 PASS

**没有动**的两个：`private: true` 和 `@local` scope —— 这两个涉及你的发布身份，需要你定。
