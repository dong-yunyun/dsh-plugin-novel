// 正式工作流端到端验证（不调用模型，只验纯规则段）
import fs from 'node:fs'
import path from 'node:path'
import {
  loadCards, validateCard, deriveGraph, buildBible, buildSynopsis,
  renderCard, runValidation, estTokens, ENUMS, scanSelfContained,
} from '../src/core/workflow.mjs'
import { WORK_DIR } from './lib/paths.mjs'

const WORK = WORK_DIR
const read = (p) => fs.readFileSync(p, 'utf8')
const manifest = JSON.parse(read(path.join(WORK, 'manifest.json')))
const cards = loadCards(path.join(WORK, 'cards'))

const graph = deriveGraph(cards)
const bible = buildBible(cards, graph)
const syn = buildSynopsis(bible, cards, { tier: 'standard' })
const report = runValidation({ manifest, cards, graph, bible, synopsisMd: syn })

const out = path.join(WORK, 'workflow-run')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'graph.json'), JSON.stringify(graph, null, 2))
fs.writeFileSync(path.join(out, 'bible.json'), JSON.stringify(bible, null, 2))
fs.writeFileSync(path.join(out, 'synopsis-continue-standard.md'), syn)
for (const c of cards) {
  const r = renderCard(c)
  fs.writeFileSync(path.join(out, `ch${String(c.chapter).padStart(4, '0')}.inject.txt`), r.text)
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))

// ---- 控制台报告 ----
const ok = (b) => (b ? 'PASS' : 'FAIL')
const rows = []
rows.push(['卡片可解析', cards.length, ok(cards.length > 0)])
rows.push(['卡片 schema 违规', report.cardIssues.length, ok(report.cardIssues.length === 0)])
rows.push(['图节点数', report.graph.nodes, ok(report.graph.nodes > 0)])
rows.push(['图边数', report.graph.edges, ok(report.graph.edges > 0)])
rows.push(['图悬空引用', report.graph.dangling, ok(report.graph.dangling === 0)])
rows.push(['图非法枚举', report.graph.badEdges, ok(report.graph.badEdges === 0)])
rows.push(['Bible 人物', report.bible.characters, ok(report.bible.characters > 0)])
rows.push(['Bible 未回收伏笔', report.bible.openThreads, ok(true)])
rows.push(['注入超预算章', report.overInject.length, ok(report.overInject.length === 0)])
rows.push(['概要 token', report.synopsisTokens, ok(report.synopsisTokens < 6000)])
rows.push(['manifest 章号状态', report.manifestStatus, ok(report.manifestStatus === 'regular' || report.manifestBreaks <= 4)])

// M14：自包含扫描（概要 + 剧本都要查）
const selfHits = scanSelfContained(syn)
rows.push(['M14 概要自包含', selfHits.length ? selfHits.join('/') : '0 命中', ok(selfHits.length === 0)])

const spDir = path.join(WORK, 'deliverables')
const spFile = path.join(spDir, '03-screenplay-unit.md')
if (fs.existsSync(spFile)) {
  const spHits = scanSelfContained(read(spFile))
  rows.push(['M14 剧本自包含', spHits.length ? spHits.join('/') : '0 命中', ok(spHits.length === 0)])
}

console.log('== 正式工作流验证 ==')
for (const [k, v, s] of rows) console.log(`  ${String(s).padEnd(5)} ${k.padEnd(22)} ${v}`)

if (report.cardIssues.length) {
  console.log('\n-- 卡片问题 --')
  for (const ci of report.cardIssues) console.log(`  ch${ci.chapter}: ${ci.issues.join('; ')}`)
}
console.log('\n-- 注入态 --')
for (const r of report.renders) {
  console.log(`  ch${String(r.chapter).padStart(4, '0')}  tok=${String(r.tokens).padStart(3)}/${r.budget}${r.over ? '  OVER' : ''}${r.trimmed.length ? '  trimmed=' + r.trimmed.join(',') : ''}`)
}
console.log(`\n产物目录: ${out}`)