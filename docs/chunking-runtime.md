# 长章分段抽取：真实运行验证记录

> 目标：验证 `splitForExtraction` + `mergePartCards` 在真实运行时可用。
> 结果：**已通过。** 过程中发现并修掉两个 merge 缺陷 + 一个注入预算缺陷。

---

## 一、故障与修复时间线

| 轮次 | 现象 | 根因 | 处理 |
|---|---|---|---|
| ① 真跑 ch84 | `缺少必填字段 schema; 存储态超预算 1201 > 950` | `mergePartCards` 的 `base` 不带 `schema`；两段条目翻倍 | 补 `schema`；新增 `enforceStorageBudget` |
| ② 重启前再跑 | 同样报错，数字变 1049 | **运行中的进程还是旧模块** | 结论：junction 换目标不生效，必须重启 |
| ③ 重启后真跑 | `done: [{ch:84, beats:5, parts:2, attempts:2}]`、`failed: []` | — | 分段抽取成功 |
| ④ 回归 | `注入超预算章 1`（ch84 注入 314 > 300） | 渲染裁剪四步走完仍超 14 token | `renderCard` 增加 6 级让步 |

---

## 二、缺陷 ①：`schema` 字段丢失

`mergePartCards(parts, base)` 里 `base` 只带 `{chapter, title, source}`，而 `schema` 只在分段结果里。合并后卡片没有 `schema`，`validateCard` 直接判「缺少必填字段」。

```js
const card = {
  schema: first.schema ?? 2,   // ← 补这一行
  ...base,
  ...
}
```

## 三、缺陷 ②：合并后超存储预算

两段各自抽到的关系/状态/伏笔叠加，合并后 1201 token，超过 density>0.8 档的 950 上限。

`enforceStorageBudget(card)`：从 beats=6 递减到 2，每级按比例收紧 entities/relations/states/items/reveals/planted 并重算；仍不收敛则进兜底分支（清空可选段、只留 beats 与钩子）。**收敛是结构性保证的。**

离线压测（按真实规模构造）：

```
merge 后: 存储态 = 1239 | 预算 = 950
收敛后: 存储态 = 939  | 保留 beats=5 实体=4 关系=3 状态=4 伏笔=3
```

## 四、缺陷 ③：注入态仍超预算

重启后抽取成功，但 ch84 渲染出 314 token（预算 300）。原因：原裁剪只有四步（ext → reveals → relations>2 → beats>4），走完仍差 14 token。

`renderCard` 增加让步序列：`items` → `entities>3` → `states>3` → `beats>3` → `planted>1` → `states>2`。

修复后：**286 / 300**，`overBudget: false`。

---

## 五、最终验证数据

### 抽取结果（真实运行）

```
pending: 1  chars: 6194  roughTokens: 3871
done: [{ chapter: 84, beats: 5, density: 0.95, parts: 2, attempts: 2 }]
failed: []
```

### 新卡片 vs 人工版

| 指标 | 新抽取 | 人工版 |
|---|---|---|
| 存储态 | 942 | 945 |
| 注入态 | 286 | 300 |
| beats | 5 | 6 |
| 状态变化 | 4（**全部带 cause**） | 3（全部带 cause） |
| 校验问题 | 无 | 无 |

新抽取的内容准确（地堡 Rush、8BB、轮空抽签都对），状态变化比人工版多一条且全部带因果。**采用新抽取版**，人工版留档在 `.backup/ch84/`。

### 全量回归

13 项全 PASS（含 `注入超预算章 0`）。

产物随之重建：概要 3,133 token、剧本 58 场、未回收伏笔 65 条。

---

## 六、发版机制的坑（重要）

他们用「切换 junction 指向新发布件」发版，但 import 说明符不变（`node_modules/dsh-novel-helper/index.js`）——**Node 的 ESM 缓存按 URL 命中，继续用旧模块**。

改 profile patch 触发的 dispose + re-import 也命中同一 URL，仍然拿到旧代码。

**结论：改 `index.js` 或 `src/**` 之后，必须重启进程才能验证；热重载救不了。**

以后凡是改代码的验证，都要先重启，否则测的是旧逻辑。这一条直接导致第 ② 轮白跑一次。
