// 规模压测：368 章全量（合成卡片，不调用模型、不写生产目录）
//
// 目的：验证规则链路在百万字规模下的耗时、内存与 token 总量。
// 合成卡片只从章文本前几行派生，只落在 .scale-sim/ 下，与生产 cards/ 完全隔离。
import fs from 'node:fs'
import path from 'node:path'
import {
  deriveGraph, buildBible, buildSynopsis, buildScreenplay, renderCard,
  validateCard, computeDensity, estTokens,
} from '../src/core/workflow.mjs'
import { WORK_DIR } from './lib/paths.mjs'

const WORK = WORK_DIR
const SIM = path.join(WORK, '.scale-sim')
fs.mkdirSync(SIM, { recursive: true })

const manifest = JSON.parse(fs.readFileSync(path.join(WORK, 'manifest.json'), 'utf8'))
const t0 = Date.now()

// ---- 1. 合成卡片（确定性，无模型）----
// 从真实卡片里取一份名字词表，让合成卡的实体/关系规模接近真实分布。
const realCards = []
for (const f of fs.readdirSync(path.join(WORK, 'cards'))) {
  if (/^ch\d+\.json$/.test(f)) realCards.push(JSON.parse(fs.readFileSync(path.join(WORK, 'cards', f), 'utf8')))
}
const vocab = [...new Set([
  ...realCards.flatMap((c) => (c.entities_new ?? []).map((e) => e.name)),
  ...realCards.flatMap((c) => (c.relations ?? []).flatMap((r) => [r.a, r.b])),
])].filter((n) => n && n.length >= 2)

const cards = []
for (const ch of manifest.chapters) {
  const file = path.join(WORK, 'chapters', path.basename(ch.file))
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n').filter((l) => l.trim())
  const beats = lines.slice(1, 7).map((l) => l.trim().slice(0, 30))
  const present = vocab.filter((n) => text.includes(n)).slice(0, 4)
  const ents = present.slice(0, 2).map((n) => ({ name: n, kind: 'person', tag: '合成' }))
  const rels = present.length >= 2
    ? [{ a: present[0], rel: 'rival', b: present[1], since: ch.chapter }]
    : []
  const states = present.length
    ? [{ subject: present[0], field: 'status', from: '未记录', to: '有变化', cause: '合成压测' }]
    : []
  const card = {
    schema: 2,
    chapter: ch.chapter,
    title: ch.title,
    source: { file: ch.file, chars: ch.chars, density: 0.5 },
    time: { story: '', span: '', mode: 'linear' },
    pov: [], location: [], beats,
    entities_new: ents, relations: rels, state_changes: states, items: [], reveals: [],
    foreshadow: { planted: beats.slice(0, 2), paid: [] },
    hook: { text: beats[beats.length - 1] ?? '', type: 'quiet' },
    ext: {}, contentRedactions: [],
  }
  card.source.density = computeDensity(card)
  cards.push(card)
}
const t1 = Date.now()

// ---- 2. 全链路 ----
const graph = deriveGraph(cards)
const t2 = Date.now()
const bible = buildBible(cards, graph)
const t3 = Date.now()
const syn = buildSynopsis(bible, cards, { tier: 'standard' })
const t4 = Date.now()
const sp = buildScreenplay(bible, cards, { unitLabel: '全书' })
const t5 = Date.now()

// ---- 3. 渲染与预算 ----
let injectTotal = 0, storageTotal = 0, over = 0
const byBand = { low: 0, mid: 0, high: 0 }
for (const c of cards) {
  const r = renderCard(c)
  injectTotal += r.tokens
  storageTotal += estTokens(JSON.stringify(c))
  if (r.overBudget) over++
  if (c.source.density < 0.6) byBand.low++
  else if (c.source.density <= 0.8) byBand.mid++
  else byBand.high++
}
const t6 = Date.now()

// ---- 4. 校验 ----
let invalid = 0
for (const c of cards) if (validateCard(c).length) invalid++
const t7 = Date.now()

// ---- 5. 落盘体积 ----
fs.writeFileSync(path.join(SIM, 'graph.json'), JSON.stringify(graph))
fs.writeFileSync(path.join(SIM, 'bible.json'), JSON.stringify(bible))
fs.writeFileSync(path.join(SIM, 'synopsis.md'), syn)
fs.writeFileSync(path.join(SIM, 'screenplay.md'), sp.md)
const sizes = Object.fromEntries(
  ['graph.json', 'bible.json', 'synopsis.md', 'screenplay.md'].map((f) => [f, fs.statSync(path.join(SIM, f)).size]),
)
const mem = process.memoryUsage()

const report = {
  chapters: cards.length,
  chars: manifest.chapters.reduce((s, c) => s + c.chars, 0),
  timings: {
    synthCards: t1 - t0, deriveGraph: t2 - t1, buildBible: t3 - t2,
    buildSynopsis: t4 - t3, buildScreenplay: t5 - t4, renderUpTo368: t6 - t5, validate: t7 - t6,
    total: t7 - t0,
  },
  tokens: { injectTotal, injectAvg: Math.round(injectTotal / cards.length), storageTotal, overBudget: over },
  bands: byBand,
  graph: { nodes: graph.nodes.length, edges: graph.edges.length },
  bible: bible.stats,
  scenes: sp.scenes,
  synopsisTokens: estTokens(syn),
  screenplayTokens: estTokens(sp.md),
  invalid,
  sizes,
  memoryMB: Math.round(mem.rss / 1024 / 1024),
}

console.log(JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(SIM, 'scale-report.json'), JSON.stringify(report, null, 2))