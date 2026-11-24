/**
 * 切分器 CLI（TypeScript 类型层 + 命令行）。
 *
 * 实现下沉在 `src/core/split.mjs`：插件跑在宿主进程里，宿主 Node 未必支持
 * 类型剥离，所以运行时不能用 .ts。这里只保留类型声明与 CLI。
 *
 * 用法：
 *   node src/ingest/split.ts --source <原文路径> --workdir <输出目录> [--name <作品名>]
 *   需要 Node ≥ 22.6（类型剥离）；Node 24 原生支持。
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  decodeSource,
  isHeading,
  parseChineseNumber,
  splitNovel,
  writeSplit,
} from '../core/split.mjs'

/** 一个章节的切分结果。 */
export interface ChapterEntry {
  chapter: number
  title: string
  declared: number
  file: string
  startLine: number
  endLine: number
  chars: number
  paragraphs: number
  sha256: string
}

/** 章号连续性断点。 */
export interface NumberingBreak {
  position: number
  declared: number
  previousDeclared: number
  delta: number
  kind: 'duplicate' | 'gap' | 'out-of-order'
}

/** 切分产物的完整清单。 */
export interface SplitManifest {
  schema: 1
  work: string
  source: { path: string; encoding: string; lineEnding: string; rawLines: number }
  generatedAt: string
  stats: { chapters: number; totalChars: number; minChars: number; maxChars: number; avgChars: number }
  frontMatter: string[]
  volumes: string[]
  rejectedHeadings: { line: number; text: string }[]
  numberingStatus: 'clean' | 'irregular'
  numberingBreaks: NumberingBreak[]
  excluded: unknown[]
  chapters: ChapterEntry[]
}

// 纯函数原样再导出，便于单测直接引用类型化入口
export { decodeSource, isHeading, parseChineseNumber, splitNovel, writeSplit }

/** 命令行入口。 */
export function main(argv: string[]): number {
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const source = arg('--source')
  const workDir = arg('--workdir')
  if (!source || !workDir) {
    console.error('用法: node src/ingest/split.ts --source <原文> --workdir <输出目录> [--name <作品名>]')
    return 2
  }
  if (!existsSync(source)) {
    console.error(`找不到原文: ${source}`)
    return 2
  }
  const bytes = readFileSync(source)
  const { text, encoding } = decodeSource(bytes)
  const result = splitNovel(text)
  const crlf = (text.match(/\r\n/g) ?? []).length
  const manifest = writeSplit(
    workDir,
    arg('--name') ?? basename(source, '.txt'),
    {
      path: basename(source),
      encoding,
      lineEnding: crlf > 0 ? 'CRLF' : 'LF',
      rawLines: text.split(/\r\n|\n/).length,
    },
    result,
  ) as unknown as SplitManifest

  const s = manifest.stats
  console.log(`编码         = ${encoding}`)
  console.log(`章节         = ${s.chapters}`)
  console.log(`总字数       = ${s.totalChars}`)
  console.log(`min/avg/max  = ${s.minChars} / ${s.avgChars} / ${s.maxChars}`)
  console.log(`章号状态     = ${manifest.numberingStatus}`)
  for (const b of manifest.numberingBreaks) {
    console.log(`  断点 pos=${b.position} declared=${b.declared} prev=${b.previousDeclared} delta=${b.delta} ${b.kind}`)
  }
  if (manifest.rejectedHeadings.length) {
    console.log(`被拒标题     = ${manifest.rejectedHeadings.length}`)
    for (const r of manifest.rejectedHeadings) console.log(`  L${r.line} ${r.text}`)
  }
  return 0
}

if (process.argv[1]?.endsWith('split.ts')) process.exit(main(process.argv.slice(2)))
