# 打包与安装验证

> 目标：把验证过的插件打成可分发件，确认**能直接装进 DSH**。
> 结论：**可行。** 已在隔离 profile 里走完"安装 → boot 解析 → 加载 → 注册工具 → 读数据"全链路。

---

## 一、打包

```powershell
cd D:\codetest\novel-plugin
pnpm pack --pack-destination dist
```

产物：`dist/local-dsh-novel-helper-0.1.0.tgz`（28 KB）

包内容（10 个文件，由 `package.json` 的 `files` 决定）：

```
package/package.json
package/index.js
package/cordis.patch.yml
package/locale/{zh,en}.json
package/icon.svg
package/src/core/workflow.mjs
package/src/ingest/{split,render,nodes}.ts
```

**刻意不打包的**：

| 项 | 原因 |
|---|---|
| `novels/` | 作品数据与代码分离，装包的人自己放 |
| `scripts/` | 开发/闸门脚本，运行时不需要 |
| `releases/`、`dist/` | 发布产物 |

---

## 二、安装方式

### 方式 A：pnpm 直接装（已验证）

```powershell
# 在 profile 目录下
pnpm add <path-to-tarball> --ignore-scripts

# 然后在 profile 的 package.json 里把包名加进 bundles
# "dsh": { "profile": { "bundles": ["dsh-novel-helper"] } }
```

### 方式 B：`dsh plugin` 命令（若该构建提供）

```powershell
dsh plugin --profile desktop add <path-to-tarball>
```

它是 pnpm 转发器 + 自动 reconcile bundles，等价于方式 A。

> 本机构建**没有** `plugin_manager` 工具，也没在 PATH 上找到 `dsh` 命令，所以这条未实测。

### 方式 C：本地目录 junction（当前生产用的就是这个）

```powershell
# profile/node_modules/dsh-novel-helper → 指向某个发布件目录
node scripts/publish.mjs --apply
```

适合"自己机器上迭代"，不适合分发。

---

## 三、验证结果

### 第 1 层：干净目录 pnpm 安装

```
+ dsh-novel-helper 0.1.0
Done in 464ms
```

装出来的 10 个文件逐个核对存在。

### 第 2 层：按 boot 的真实解析规则定位

复刻 `packages/boot/app-boot/src/profile.ts` 的 `resolveBundleDir()`：
安装锚点优先，其次 profile 目录，走 `require.resolve.paths()` 的 node_modules 链。

```
解析到的包目录 = C:\Users\PC\.dsh\profiles\_installtest\node_modules\@local\dsh-novel-helper
包名/版本      = dsh-novel-helper 0.1.0
bundle patch   = ./cordis.patch.yml 存在: true
导出           = apply,inject | inject = ["tools","llm"]
```

### 第 3 层：加载与运行

```
注册工具数     = 6 → novel_ingest, novel_status, novel_context, novel_continue, novel_scenes, novel_synopsis
数据可读       = {"chapters":368,"cards":31}
留空时工具数   = 0 （应为 0）
```

最后一行是关键契约：**`novelDir` 为空时不注册任何工具**，与生产闸门的 `activation` 检查一致。

### 第 4 层：清理

临时 profile 与临时安装目录已删除，`profiles/` 下只剩 `desktop`。

---

## 四、装完之后还要做什么

包装进去只是第一步，**没有数据时插件是待命的**。完整上手顺序：

| 步骤 | 操作 |
|---|---|
| 1 | 把小说原文放到 `novels/<作品名>/source/` |
| 2 | 切分：`node src/ingest/split.ts --source <原文> --workdir novels/<作品名>` |
| 3 | 抽取卡片：调 `novel_ingest` 工具（继承当前模型路由，无需配置） |
| 4 | 在 profile patch 里把 `novelDir` 指到 `novels/<作品名>`（相对或绝对都行） |
| 5 | 重启 DSH |

第 4 步是必须的——插件不会替你猜作品目录。

---

## 五、已知限制

1. **`.ts` 脚本需要 Node ≥ 24**（类型剥离）。插件本体是 `.mjs`，不受影响；只有 `src/ingest/*.ts` 三个开发脚本需要。
2. **打包不含闸门脚本**。别人装完只拿到运行时，拿不到 `verify.mjs` / `gate:selftest`。
3. **`dsh plugin` 命令未实测**——本机构建没有该命令。

---

## 复现

```powershell
cd D:\codetest\novel-plugin
pnpm pack --pack-destination dist

# 干净目录安装
mkdir $env:TEMP\it && cd $env:TEMP\it
pnpm add D:\codetest\novel-plugin\dist\local-dsh-novel-helper-0.1.0.tgz --ignore-scripts
```
