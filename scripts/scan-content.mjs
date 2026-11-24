// M18 全量内容策略扫描（兜底冒烟，不是主判据）
//
// 扫三处：
//   1. cards/  —— 卡片的所有字符串字段
//   2. synopses/ 与 deliverables/ —— 概要、续写包、剧本包
//   3. contentRedactions 的结构完整性（行区间是否合法）
//
// 只报计数与词，不输出原文。
import fs from 'node:fs'
import path from 'node:path'
import { scanPolicyTerms } from '../src/core/workflow.mjs'
import { WORK_DIR, TERMS_PATH } from './lib/paths.mjs'

const WORK = WORK_DIR
const TERMS_FILE = TERMS_PATH

const terms = fs.readFileSync(TERMS_FILE, 'utf8').split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))

const manifest = JSON.parse(fs.readFileSync(path.join(WORK, 'manifest.json'), 'utf8'))
const chapterLines = new Map()
for (const ch of manifest.chapters) {
  const f = path.join(WORK, 'chapters', path.basename(ch.file))
  if (fs.existsSync(f)) chapterLines.set(ch.chapter, fs.readFileSync(f, 'utf8').split('\n').length)
}

// ---- 1. 卡片 ----
const cardDir = path.join(WORK, 'cards')
const cardFiles = fs.readdirSync(cardDir).filter((f) => /^ch\d+\.json$/.test(f)).sort()
const cardHits = []
const redactionIssues = []
for (const f of cardFiles) {
  const card = JSON.parse(fs.readFileSync(path.join(cardDir, f), 'utf8'))
  const flat = JSON.stringify(card)
  const { total, hits } = scanPolicyTerms(flat, terms)
  if (total > 0) cardHits.push({ file: f, chapter: card.chapter, total, hits, hasRedaction: (card.contentRedactions ?? []).length > 0 })

  const maxLine = chapterLines.get(card.chapter) ?? Infinity
  for (const r of card.contentRedactions ?? []) {
    if (!Number.isInteger(r.startLine) || !Number.isInteger(r.endLine)
      || r.startLine < 1 || r.endLine < r.startLine || r.endLine > maxLine) {
      redactionIssues.push({ file: f, redaction: r, maxLine })
    }
  }
}

// ---- 2. 产物 ----
const productDirs = [path.join(WORK, 'synopses'), path.join(WORK, 'deliverables')]
const productHits = []
for (const dir of productDirs) {
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir)) {
    if (!/\.md$/.test(f)) continue
    const { total, hits } = scanPolicyTerms(fs.readFileSync(path.join(dir, f), 'utf8'), terms)
    if (total > 0) productHits.push({ file: `${path.basename(dir)}/${f}`, total, hits })
  }
}

// ---- 3. 报告 ----
const cardsWithRedaction = cardFiles.filter((f) => {
  const c = JSON.parse(fs.readFileSync(path.join(cardDir, f), 'utf8'))
  return (c.contentRedactions ?? []).length > 0
}).length

console.log('=== M18 内容策略扫描（兜底）===')
console.log(`词表条目            = ${terms.length}`)
console.log(`扫描卡片            = ${cardFiles.length}`)
console.log(`带回滚记录的卡片     = ${cardsWithRedaction}`)
console.log(`卡片命中            = ${cardHits.length}`)
console.log(`产物命中            = ${productHits.length}`)
console.log(`contentRedactions 结构问题 = ${redactionIssues.length}`)

if (cardHits.length) {
  console.log('\n-- 卡片命中（需人工复核）--')
  for (const h of cardHits) console.log(`  ${h.file}  ${h.total} 次  [${h.hits.map((x) => x.term).join(',')}]  ${h.hasRedaction ? '有回滚记录' : '⚠ 无回滚记录'}`)
}
if (productHits.length) {
  console.log('\n-- 产物命中 --')
  for (const h of productHits) console.log(`  ${h.file}  ${h.total} 次  [${h.hits.map((x) => x.term).join(',')}]`)
}
if (redactionIssues.length) {
  console.log('\n-- 行区间问题 --')
  for (const r of redactionIssues) console.log(`  ${r.file}  ${JSON.stringify(r.redaction)}  文件行数=${r.maxLine}`)
}

// 判定分级：
//   卡片命中 / 行区间问题 → 失败（机器产物，应为零）
//   产物命中            → 只提示人工复核（散文里"高潮"常指剧情高潮，词表必然误伤）
const fail = cardHits.length > 0 || redactionIssues.length > 0
console.log('')
if (fail) {
  console.log('结论：FAIL（卡片命中或行区间非法）')
} else if (productHits.length) {
  console.log(`结论：PASS（卡片零命中、行区间合法）；产物有 ${productHits.length} 处待人工复核`)
} else {
  console.log('结论：PASS（零命中、行区间合法）')
}
process.exit(fail ? 2 : 0)