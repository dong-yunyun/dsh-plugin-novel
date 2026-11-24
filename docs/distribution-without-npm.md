# 没有 npm 怎么分发

> 情况：本机没有 npm，也没有 npm 账号；DSH 没有内置插件市场。
> **结论：不需要 npm —— 直接从 GitHub 装。已实测通过。**

---

## 一、DSH 有没有官方插件市场

**没有。** 在安装包里搜过 `marketplace` / `pluginStore` / `plugin-market` / `registry.npmjs` / `插件市场`，只命中一个无关的 `@swc/helpers/package.json`。

DSH 里和插件相关的只有两个包：

| 包 | 作用 |
|---|---|
| `host/plugin-inventory` | 读取 Cordis Loader 当前条目，投影给 UI（只读） |
| `client/ui-settings-plugin-inventory` | 设置页里那个"插件清单"页，展示上面的投影 |

**没有安装、没有商店、没有 registry 客户端**，也没有 `plugin_manager` 工具。所以你看到的"插件目录"只是"已加载了什么"的展示，不是市场。

---

## 二、不需要 npm：从 GitHub 直接装

pnpm 支持 git 依赖。因为仓库是公开的，任何人可以：

```powershell
# 在 profile 目录下
pnpm add github:dong-yunyun/dsh-plugin-novel

# 然后把 dsh-novel-helper 加进 package.json 的 dsh.profile.bundles
```

### 实测记录

在干净临时目录里执行 `pnpm add github:dong-yunyun/dsh-plugin-novel`：

```
+ dsh-novel-helper 0.2.2
Done in 2m 18.8s
```

装出来的内容与 npm 包完全一致（13 个文件：index / patch / locale / src / icon / README / LICENSE）。

加载验证：

```
工具数 = 7 → novel_import, novel_ingest, novel_status, novel_context, novel_continue, novel_scenes, novel_synopsis
数据可读 = 368 章 / 47 卡片
```

**完全可用，全程没碰 npm。**

---

## 三、三种分发方式对比

| 方式 | 需要 npm 账号 | 用户命令 | 代价 |
|---|---|---|---|
| **GitHub 直装**（推荐给你） | ❌ 不需要 | `pnpm add github:<用户>/<仓库>` | 首次要 clone，2 分钟级；更新要 `pnpm update` |
| GitHub Release + tarball | ❌ 不需要 | `pnpm add <tarball 的 URL 或本地路径>` | 每次发版要手动传 tgz |
| npm | ✅ 需要 | `pnpm add dsh-novel-helper` | 最快、可发现性最好，但要有账号 |

### 用 tag 固定版本

直装默认拉默认分支最新提交。要锁版本：

```powershell
pnpm add github:dong-yunyun/dsh-plugin-novel#v0.2.2
```

所以发版时打个 tag 就够了，不需要 npm 也不需要传文件。

---

## 四、给你自己机器装的步骤

```powershell
# 1. 进 profile 目录
cd C:\Users\PC\.dsh\profiles\desktop

# 2. 从 GitHub 装
pnpm add github:dong-yunyun/dsh-plugin-novel

# 3. 编辑 package.json，把 "dsh-novel-helper" 加进 dsh.profile.bundles

# 4. 重启 DSH
```

配置 `cordis.patch.yml` 里的 `novelDir` 指向作品目录即可。

---

## 五、什么情况下才值得去搞 npm

| 场景 | 建议 |
|---|---|
| 只给自己和同事用 | ❌ 不用 npm，GitHub 直装足够 |
| 想让陌生人"搜到就能装" | ✅ 值得，npm 是唯一被广泛检索的入口 |
| 想接将来的官方市场 | 先看那个市场要求什么，大概率也是 npm 包名 |

**现在这个阶段：不需要 npm。**
