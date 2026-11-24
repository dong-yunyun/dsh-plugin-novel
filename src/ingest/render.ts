/**
 * 卡片渲染器 CLI：把 cards/*.json 渲染成注入态文本。
 *
 * 从 render.ps1 迁到 TypeScript。渲染逻辑本身在 `src/core/workflow.mjs` 的
 * `renderCard()` 里——这里只做批量读取、落盘与统计，避免出现第二份实现。
 *
 * 用法：
 *   node src/ingest/render.ts --cards <cards 目录> [--suffix .render.txt]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderCard } from '../core/workflow.mjs'

/** 卡片的最小结构：渲染只依赖 chapter 与其余渲染字段。 */
interface CardInput {
  chapter: number
  [key: string]: unknown
}

export interface RenderSummary {
  chapter: number
  tokens: number
  budget: number
  trimmed: string[]
  overBudget: boolean
  file: string
}

/** 批量渲染一个目录下的卡片并落盘，返回每章统计。 */
export function renderDirectory(cardDir: string, suffix = '.render.txt'): RenderSummary[] {
  const out: RenderSummary[] = []
  const files = readdirSync(cardDir).filter((f) => /^ch\d+\.json$/.test(f)).sort()
  for (const f of files) {
    const card = JSON.parse(readFileSync(join(cardDir, f), 'utf8')) as CardInput
    const r = renderCard(card as never)
    const dest = join(cardDir, f.replace(/\.json$/, suffix))
    writeFileSync(dest, r.text, 'utf8')
    out.push({
      chapter: card.chapter,
      tokens: r.tokens,
      budget: r.budget.inject,
      trimmed: r.trimmed,
      overBudget: r.overBudget,
      file: dest,
    })
  }
  return out
}

/** 命令行入口：`node render.ts --cards <dir> [--suffix .render.txt]`。 */
export function main(argv: string[]): number {
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const cards = arg('--cards')
  if (!cards) {
    console.error('用法: node src/ingest/render.ts --cards <cards 目录> [--suffix .render.txt]')
    return 2
  }
  const dir = resolve(cards)
  if (!existsSync(dir)) {
    console.error(`找不到目录: ${dir}`)
    return 2
  }
  const summary = renderDirectory(dir, arg('--suffix') ?? '.render.txt')
  const over = summary.filter((s) => s.overBudget)
  const total = summary.reduce((acc, s) => acc + s.tokens, 0)
  for (const s of summary) {
    const flag = s.overBudget ? '  OVER' : ''
    const trim = s.trimmed.length ? `  trimmed=${s.trimmed.join(',')}` : ''
    console.log(`ch${String(s.chapter).padStart(4, '0')}  tok=${String(s.tokens).padStart(3)}/${s.budget}${flag}${trim}`)
  }
  console.log(`\n章节=${summary.length}  合计=${total} tok  均值=${Math.round(total / Math.max(1, summary.length))}  超预算=${over.length}`)
  return over.length === 0 ? 0 : 1
}

if (process.argv[1]?.endsWith('render.ts')) process.exit(main(process.argv.slice(2)))
