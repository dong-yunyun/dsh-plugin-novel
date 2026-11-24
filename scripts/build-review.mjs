// 生成人工评审包：M6 卡片重建 + M12 冷启动续写 + M13 单元剧本
import fs from 'node:fs'
import path from 'node:path'
import {
  loadCards, deriveGraph, buildBible, buildSynopsis, buildScreenplay, renderCard, estTokens,
} from '../src/core/workflow.mjs'
import { WORK_DIR } from './lib/paths.mjs'

const WORK = WORK_DIR
const OUT = path.join(WORK, 'review')
fs.mkdirSync(OUT, { recursive: true })

const cards = loadCards(path.join(WORK, 'cards'))
const byChapter = [...cards].sort((a, b) => a.chapter - b.chapter)
const graph = deriveGraph(cards)
const bible = buildBible(cards, graph)

// ---- M6：按 density 分层抽 20 章 ----
const byDensity = [...cards].sort((a, b) => a.source.density - b.source.density)
const low = byDensity.slice(0, 7)
const high = byDensity.slice(-6)
const midPool = byDensity.slice(7, byDensity.length - 6)
const mid = midPool.filter((_, i) => i % Math.max(1, Math.floor(midPool.length / 7)) === 0).slice(0, 7)
const sample = [...low, ...mid, ...high].filter((v, i, a) => a.indexOf(v) === i)
  .sort((a, b) => a.chapter - b.chapter)

const L = []
L.push('# M6 评审包 · 卡片重建测试')
L.push('')
L.push(`> 样本 ${cards.length} 章中按 density 分层抽 ${sample.length} 章｜全部内容来自插件自动抽取`)
L.push('> **规则：只看下面给出的卡片渲染态，不要回看原文。** 如果某项答不出来，那说明卡片缺信息——这正是要测的。')
L.push('')
L.push('## 计分表')
L.push('')
L.push('| 章 | 谁登场 | 变化了什么 | 得到/失去 | 埋了什么 | 结尾钩子 | 全中? |')
L.push('|---|---|---|---|---|---|---|')
for (const c of sample) L.push(`| ${c.chapter} |  |  |  |  |  |  |`)
L.push('')
L.push('> 达标线：5 项全中的比例 ≥ 80%（即至少 16/20 章全中）。')
L.push('')
L.push('---')
L.push('')

for (const c of sample) {
  const r = renderCard(c)
  L.push(`## 第 ${c.chapter} 章`)
  L.push('')
  L.push(`> density ${c.source.density}｜注入态 ${r.tokens} / 预算 ${r.budget.inject}${r.trimmed.length ? `｜已裁剪 ${r.trimmed.join(',')}` : ''}`)
  L.push('')
  L.push('```')
  L.push(r.text)
  L.push('```')
  L.push('')
  L.push('| 项 | 你的答案 |')
  L.push('|---|---|')
  L.push('| 谁登场 |  |')
  L.push('| 他变化了什么 |  |')
  L.push('| 得到/失去了什么 |  |')
  L.push('| 埋了什么 |  |')
  L.push('| 结尾钩子是什么 |  |')
  L.push('')
}
fs.writeFileSync(path.join(OUT, 'M6-card-review.md'), L.join('\n'))

// ---- M12：冷启动续写（用续写简报驱动）----
const syn = buildSynopsis(bible, cards, { tier: 'standard' })
const briefPath = path.join(OUT, 'M12-brief.md')
const brief = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, 'utf8') : '（尚未生成，先跑 novel_continue）'
const m12 = [
  '# M12 冷启动续写评审',
  '',
  '> 用法：**新开一个会话，不加载任何插件，不提供原文**，只把下面「测试输入」整段粘进去，让模型续写 2000 字。',
  '> 然后按评分表打分。',
  '',
  '## 评分表',
  '',
  '| 项 | 判定 | 说明 |',
  '|---|---|---|',
  '| 人称/时态一致 | 有/无 | 与概要里的样本一致 |',
  '| 文风接近 | 有/无 | 是否像同一本书 |',
  '| 人名/称谓无错乱 | 有/无 | 重点看苟小云、Lulu、Kay、楚南行 |',
  '| 未详写对战细节 | 有/无 | 简报明令：比赛只用结果、片段、旁观反应带过 |',
  '| 方少云战绩一般、两败出局 | 有/无 | 输得干脆，不写成连胜；两败的落点自洽 |',
  '| 主线成功移交给苟小云 | 有/无 | 出场后重心转到胜者组 |',
  '| 苟小云乱杀进决赛 | 有/无 | 一路碾压，不写成险胜缠斗 |',
  '| 师徒反差成立 | 有/无 | 徒弟止步、师父乱杀 |',
  '| 师徒关系未公开 | 有/无 | 公开场合只以网友/同行者相处 |',
  '| 承接第 84 章赛后局面 | 有/无 | 败者组九人、苟小云轮空、饭桌点破 |',
  '',
  '> 三档判定：直接可用 / 小改可用 / 不可用。**小改可用及以上算达标。**',
  '',
  '## 测试输入（整段复制）',
  '',
  '```text',
  '===== 前情概要 =====',
  syn,
  '',
  '===== 续写简报 =====',
  brief,
  '',
  '===== 任务 =====',
  '严格按上面的续写简报写 2000 字正文。简报里「禁止」列出的内容一律不写；「需澄清」的几条，你按最自然的一种理解处理，并在正文里自洽。不要复述简报，不要解释你在做什么。',
  '```',
  '',
].join('\n')
fs.writeFileSync(path.join(OUT, 'M12-continue-review.md'), m12)

// ---- M13：单元剧本 ----
const unit = byChapter.filter((c) => c.chapter >= 1 && c.chapter <= 9)
const unitBible = buildBible(unit, deriveGraph(unit))
const scenesDir2 = path.join(WORK, 'scenes')
const scenesForUnit = {}
if (fs.existsSync(scenesDir2)) {
  for (const f of fs.readdirSync(scenesDir2)) {
    if (/^ch\d+\.json$/.test(f)) scenesForUnit[Number(f.replace(/\D/g, ''))] = JSON.parse(fs.readFileSync(path.join(scenesDir2, f), 'utf8'))
  }
}
const sp = buildScreenplay(unitBible, unit, { unitLabel: '第 1–9 章（开局单元）', scenesByChapter: scenesForUnit })
const m13 = [
  '# M13 单元剧本评审',
  '',
  '> 用法：**新开会话、不加载插件、不给原文**，只粘「测试输入」，要求模型产出「场次表 + 一场完整戏」。',
  '',
  '## 评分表',
  '',
  '| 项 | 判定 |',
  '|---|---|',
  '| 场次表要素齐全（场/地点/时间/人物/动作） | 有/无 |',
  '| 示范戏可直接拍摄（有场景描述与对白） | 有/无 |',
  '| 没有蔓延到单元之外 | 有/无 |',
  '| 对白符合人物身份 | 有/无 |',
  '',
  '> 达标线：三档判定「可用」≥ 70%。',
  '',
  '## 测试输入（整段复制）',
  '',
  '```text',
  sp.md,
  '',
  '---',
  '请基于上面的单元剧本包，产出：1）场次表（含场号/地点/时间/人物/冲突/结果）；2）其中一场的完整戏（含场景描述与对白）。只做这一个单元，不要扩写其他章节。',
  '```',
  '',
].join('\n')
fs.writeFileSync(path.join(OUT, 'M13-screenplay-review.md'), m13)

console.log('样本卡片数 =', cards.length)
console.log('M6 抽样 =', sample.length, '章 →', sample.map((c) => c.chapter).join(','))
console.log('M6 文件 =', path.join(OUT, 'M6-card-review.md'), `${fs.statSync(path.join(OUT, 'M6-card-review.md')).size}B`)
console.log('M12 文件 =', `${estTokens(m12)} tok`)
console.log('M13 文件 =', `${estTokens(m13)} tok`, `场次=${sp.scenes}`)