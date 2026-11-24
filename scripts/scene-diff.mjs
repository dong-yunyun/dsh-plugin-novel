// 场次表 diff v2：插件输出 vs 人工基准（对齐冲突/结果列）
import fs from 'node:fs'
import { join } from 'node:path'
import path from 'node:path'
import { loadCards, buildBible, buildScreenplay, deriveGraph } from '../src/core/workflow.mjs'
import { WORK_DIR, REFERENCE_DIR } from './lib/paths.mjs'

const WORK = WORK_DIR
const GT = join(REFERENCE_DIR, 'scenes-ground-truth-ch1-9.md')

const gtRows = fs.readFileSync(GT, 'utf8').split('\n')
  .filter((l) => /^\| \d+/.test(l))
  .map((l) => {
    const c = l.split('|').slice(1, -1).map((s) => s.trim())
    return { scene: Number(c[0]), chapter: Number(c[1]), place: c[2], text: `${c[5]} ${c[6]}` }
  })

const cards = loadCards(path.join(WORK, 'cards'))
const unit = cards.filter((c) => c.chapter >= 1 && c.chapter <= 9).sort((a, b) => a.chapter - b.chapter)
const scenesDir = path.join(WORK, 'scenes')
const scenesByChapter = {}
for (const f of fs.readdirSync(scenesDir)) {
  if (/^ch\d+\.json$/.test(f)) scenesByChapter[Number(f.replace(/\D/g, ''))] = JSON.parse(fs.readFileSync(path.join(scenesDir, f), 'utf8'))
}
const sp = buildScreenplay(buildBible(unit, deriveGraph(unit)), unit, { unitLabel: 'x', scenesByChapter })
const mine = sp.md.split('\n').filter((l) => /^\| \d+ \| \d+ \|/.test(l)).map((l) => {
  const c = l.split('|').slice(1, -1).map((s) => s.trim())
  return { scene: Number(c[0]), chapter: Number(c[1]), place: c[2], conflict: c[5], result: c[6], text: `${c[5]} ${c[6]}`, source: c[8] }
})

const bigrams = (s) => {
  const t = String(s).replace(/[\s，。、；：？！「」“”（）()—–]/g, '')
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}
const sim = (a, b) => {
  const A = bigrams(a), B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

// 一对一贪心：先算所有候选，按分数降序分配，避免先到先得
const cands = []
for (const g of gtRows) {
  for (const m of mine) {
    if (m.chapter !== g.chapter) continue
    const s = Math.max(sim(g.text, m.text), sim(g.place, m.place) * 0.6)
    if (s > 0) cands.push({ g, m, s })
  }
}
cands.sort((a, b) => b.s - a.s)
const gtDone = new Set(), mineDone = new Set()
const pairs = []
for (const c of cands) {
  if (gtDone.has(c.g.scene) || mineDone.has(c.m.scene)) continue
  if (c.s < 0.08) continue
  gtDone.add(c.g.scene); mineDone.add(c.m.scene)
  const placeOk = c.m.place.includes(c.g.place.split('·')[0].split('／')[0])
    || c.g.place.includes(c.m.place.split('·')[0])
  pairs.push({ ...c, placeOk })
}
const missing = gtRows.filter((g) => !gtDone.has(g.scene))
const extra = mine.filter((m) => !mineDone.has(m.scene))
const badPlace = pairs.filter((p) => !p.placeOk)

const pct = (n, d) => ((n / d) * 100).toFixed(1) + '%'
console.log('=== 场次级 diff v2（第 1–9 章，全章已原文拆场）===')
console.log(`基准场次              = ${gtRows.length}`)
console.log(`插件场次              = ${mine.length}`)
console.log(`匹配上                = ${pairs.length}  (${pct(pairs.length, gtRows.length)})`)
console.log(`漏场                  = ${missing.length}`)
console.log(`多场                  = ${extra.length}`)
console.log(`匹配上场次地点不符     = ${badPlace.length}  (${pct(badPlace.length, Math.max(1, pairs.length))})`)

console.log('\n-- 漏场 --')
for (const g of missing) console.log(`  第 ${g.chapter} 章 | ${g.place} | ${g.text.slice(0, 44)}`)
console.log('\n-- 多场 --')
for (const m of extra) console.log(`  第 ${m.chapter} 章 | ${m.place} | ${m.text.slice(0, 44)}`)
console.log('\n-- 地点不符 --')
for (const p of badPlace) console.log(`  第 ${p.g.chapter} 章 | 基准「${p.g.place}」 vs 插件「${p.m.place}」 | ${p.m.text.slice(0, 30)}`)

fs.writeFileSync(join(REFERENCE_DIR, 'scene-diff.json'), JSON.stringify({ pairs: pairs.map(p => ({ chapter: p.g.chapter, gt: p.g.place, mine: p.m.place, placeOk: p.placeOk, score: +p.s.toFixed(3) })), missing, extra }, null, 2))