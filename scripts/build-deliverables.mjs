// 三个功能端到端产出：续写包 / 剧本包 / 概要
import fs from 'node:fs'
import path from 'node:path'
import {
  loadCards, deriveGraph, buildBible, buildSynopsis, buildScreenplay, renderCard, estTokens,
} from '../src/core/workflow.mjs'
import { WORK_DIR } from './lib/paths.mjs'

const WORK = WORK_DIR
const OUT = path.join(WORK, 'deliverables')
fs.mkdirSync(OUT, { recursive: true })

const cards = loadCards(path.join(WORK, 'cards'))
const graph = deriveGraph(cards)
const bible = buildBible(cards, graph)
const byCh = (a, b) => cards.filter((c) => c.chapter >= a && c.chapter <= b)

const written = []

// ---- 1. 概要（continue / standard）----
const syn = buildSynopsis(bible, cards, { tier: 'standard' })
fs.writeFileSync(path.join(OUT, '01-synopsis.md'), syn)
written.push(['01-synopsis.md', estTokens(syn)])

// ---- 2. 续写包 = 概要 + 最近 N 章注入态 ----
const recent = cards.slice(-3).map((c) => renderCard(c))
const cont = [
  syn,
  '',
  '## 附：最近 3 章注入态（模型实际看到的前情）',
  '',
  recent.map((r) => r.text).join('\n\n'),
  '',
  `> 注入态合计 ${recent.reduce((s, r) => s + r.tokens, 0)} token；` +
  `其中超预算章已按 ext→reveals→relations→beats 顺序裁剪。`,
].join('\n')
fs.writeFileSync(path.join(OUT, '02-continue-pack.md'), cont)
written.push(['02-continue-pack.md', estTokens(cont)])

// ---- 3. 剧本包：单个叙事单元（第 1–9 章）----
const unit = byCh(1, 9)
const unitBible = buildBible(unit, deriveGraph(unit))
const scenesDir = path.join(WORK, 'scenes')
const scenesByChapter = {}
if (fs.existsSync(scenesDir)) {
  for (const f of fs.readdirSync(scenesDir)) {
    if (/^ch\d+\.json$/.test(f)) scenesByChapter[Number(f.replace(/\D/g, ''))] = JSON.parse(fs.readFileSync(path.join(scenesDir, f), 'utf8'))
  }
}
const sp = buildScreenplay(unitBible, unit, { unitLabel: '第 1–9 章（开局单元）', scenesByChapter })
fs.writeFileSync(path.join(OUT, '03-screenplay-unit.md'), sp.md)
written.push(['03-screenplay-unit.md', estTokens(sp.md)])

console.log('=== 三个功能产出 ===')
for (const [f, t] of written) {
  const p = path.join(OUT, f)
  console.log(`  ${f.padEnd(26)} ${String(t).padStart(5)} tok  ${fs.statSync(p).size}B`)
}
console.log(`  剧本场次 = ${sp.scenes}`)
console.log(`  概要人物 = ${bible.characters.length}  未回收伏笔 = ${bible.openThreads.filter((t) => t.status === 'open').length}`)