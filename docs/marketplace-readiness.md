# 上架就绪度评估

> 问题：现在这个插件能发到插件市场了吗？还需要补什么？
> **答：代码侧已经就绪，剩下的是"发布身份"和"npm 账号"，这些只能你来。**

---

## 一、先澄清：这个 DSH 构建没有插件市场

我在源码里找过：只有 `ui-settings-plugin-inventory`（只读的插件清单页）和 `host/plugin-inventory`（把 Loader 条目投影给 UI）。**没有商店、没有安装 UI、没有 registry 客户端**，也没有 `plugin_manager` 工具。

所以"发布到市场"在当前生态里 = **发到 npm**，用户 `pnpm add dsh-novel-helper` 后加进 `dsh.profile.bundles`。

如果将来有官方市场，它的入口大概率也是 npm 包 + 仓库里的元数据，下面的准备工作都通用。

---

## 二、已经做完的（代码侧）

| 项 | 状态 |
|---|---|
| 包名 | `dsh-novel-helper`（npm 上 404，未被占用） |
| `private` | `false` |
| `license` | MIT，含 LICENSE 文件 |
| README | ✅ 含快速开始 / 七个工具 / 成本提示 / 已知限制 |
| 元数据 | ✅ `author` / `repository` / `homepage` / `bugs` / `publishConfig` |
| `engines` | `node >= 22.6` |
| `files` | 只发布运行时（index / patch / src / locale / icon / README / LICENSE），35 KB |
| CI | ✅ `.github/workflows/ci.yml`：Node 22 / 24 双版本语法检查 + 冒烟 |
| 无数据冒烟 | ✅ `npm run ci`，用 `fixtures/` 的小样跑通"导入 → 切分 → 注册 7 个工具" |
| 仓库卫生 | ✅ `novels/`、`related/`、`dist/`、`releases/`、`.backup/` 已在 `.gitignore`；文档里的本机绝对路径已泛化 |
| 生产闸门 | ✅ `verify` 9/9（在本机，需真实作品数据） |

**版权上最关键的一条**：小说原文没有进仓库。`novels/` 与 `related/` 被忽略，GitHub 上只有代码和 `fixtures/` 里自写的测试小样。

---

## 三、还需要你补的（只有三项）

### ① npm 账号与发布凭证

```powershell
npm login          # 或设置 NPM_TOKEN
npm publish        # 在仓库根目录
```

这是唯一真正卡住"发布"的动作。我不能替你做，也不该拿你的凭证。

发布前建议先干跑：

```powershell
npm pack --dry-run   # 确认只打了那 9 个文件
```

### ② 决定包名归属

现在是无 scope 的 `dsh-novel-helper`。两种选择：

| 选择 | 好处 | 代价 |
|---|---|---|
| 保持无 scope（推荐） | 名字短、已验证未被占用 | 将来若要转 scope 需 `npm deprecate` 旧包 |
| 改用 `@dong-yunyun/dsh-novel-helper` | 与组织绑定，便于统一管理 | 需要 scope 权限；包名要同步改 patch / bundles / 文档 |

要改 scope 告诉我，改名是机械工作，能全改完并复验。

### ③ 首次安装的体验（可选，但建议）

出厂 `novelDir: ''` → **一个工具都不注册**。这是生产闸门的契约（未配置即待命），但对新用户来说：装完、重启、看不到任何 `novel_*` 工具，第一反应是"装失败了"。

三个可选方案：

1. 保持现状，只在 README 强调（成本 0）
2. `novelDir` 为空时仍注册**一个**只读的 `novel_status`，返回"未配置"（要同步改闸门的 activation 断言）
3. 在 profile patch 里预填示例路径并注释掉（最省事，但容易误导）

---

## 四、发布之后建议补的

| 项 | 为什么 |
|---|---|
| GitHub Release + tag（`v0.2.2`） | npm 页面会挂版本历史 |
| repo 的 About / topics（`dsh-plugin`、`novel`） | 提高可发现性 |
| 一段 30 秒演示（截图或 asciinema） | "省 token"的价值靠说很难信，看一眼就懂 |
| 跨平台验证（Linux / macOS） | 目前只在 Windows 跑过；CI 的 Ubuntu 只覆盖冒烟，没跑真实抽取 |

---

## 五、结论

| 目标 | 现在能不能 |
|---|---|
| GitHub 上公开源码 | ✅ 已推，且不含版权内容 |
| 发到 npm | ✅ 准备好，**只差 `npm login` + `npm publish`** |
| 官方插件市场 | ❌ 当前构建没有市场；等它出现再按它的规范补元数据 |

一句话：**代码侧我没有待办了，剩下的三件都在你手上。**
