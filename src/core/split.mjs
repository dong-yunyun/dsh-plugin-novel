/**
 * 切分核心（运行时可用，纯 JS）。
 *
 * 为什么不做成 .ts：插件跑在 DSH 宿主进程里，宿主的 Node 未必支持类型剥离
 * （`process.features.typescript === 'strip'` 只在 Node ≥ 22.6 才有）。
 * 运行时要稳，所以实现放 .mjs；`src/ingest/split.ts` 只做类型与 CLI 包装。
 *
 * 移植自 split.ps1，保留了三处踩过坑的处理：
 *   1. 正文段落会被「第…节」误命中 → 标题行必须 ≤ 40 字且不含句号
 *   2. 章号可能重号/跳号/倒序 → 位置序号为权威，声明章号只作元数据
 *   3. 下载站水印要先剥离，再识别标题
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HEADING_RE = /^第\s*([0-9一二三四五六七八九十百千零两〇]+)\s*[章节回]/
const VOLUME_RE = /^\s*第\s*[0-9一二三四五六七八九十百千零两〇]+\s*卷/
const WATERMARK_RE = /(知轩藏书|zxcs|^\s*=+\s*$|更多精校小说)/

/** 中文数字转整数；纯阿拉伯数字直接解析。 */
export function parseChineseNumber(text) {
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10)
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units = { 十: 10, 百: 100, 千: 1000 }
  let section = 0
  let num = 0
  for (const ch of text) {
    if (ch in digits) num = digits[ch]
    else if (ch in units) {
      if (num === 0) num = 1
      section += num * units[ch]
      num = 0
    }
  }
  return section + num
}

/** 判断一行是否是章节标题（长度与句号约束来自真实语料的误命中）。 */
export function isHeading(line) {
  const t = line.trim()
  if (t.length === 0 || t.length > 40) return false
  if (t.includes('。')) return false
  return HEADING_RE.test(t)
}

/** 按 BOM 与字节有效性判断编码，GB18030 为回退。 */
export function decodeSource(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8(BOM)' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'GB18030' }
  }
}

/**
 * 切分一部作品。纯函数：不写盘，便于单测与"导入前探测"。
 * @returns manifest 与逐章正文
 */
export function splitNovel(rawText) {
  const lines = rawText.split(/\r\n|\n/).filter((l) => !WATERMARK_RE.test(l))

  const headings = []
  const rejected = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]
    if (!HEADING_RE.test(t.trim())) continue
    if (isHeading(t)) headings.push({ index: i, text: t.trim() })
    else rejected.push({ line: i + 1, text: t.trim().slice(0, 40) })
  }
  if (headings.length === 0) throw new Error('未找到任何章节标题')

  const frontMatter = lines.slice(0, headings[0].index).filter((l) => l.trim() !== '')

  const chapters = []
  const breaks = []
  let prevDeclared = 0

  headings.forEach((h, k) => {
    const start = h.index
    const end = k < headings.length - 1 ? headings[k + 1].index - 1 : lines.length - 1
    const body = lines.slice(start, end + 1).join('\n').trimEnd()
    const num = k + 1
    const m = HEADING_RE.exec(h.text)
    const declared = m?.[1] ? parseChineseNumber(m[1]) : 0

    const delta = declared - prevDeclared
    if (k > 0 && delta !== 1) {
      breaks.push({
        position: num,
        declared,
        previousDeclared: prevDeclared,
        delta,
        kind: delta === 0 ? 'duplicate' : delta > 1 ? 'gap' : 'out-of-order',
      })
    }
    prevDeclared = declared

    chapters.push({
      entry: {
        chapter: num,
        title: h.text,
        declared,
        file: `chapters/ch${String(num).padStart(4, '0')}.md`,
        startLine: start + 1,
        endLine: end + 1,
        chars: body.length,
        paragraphs: body.split('\n').filter((l) => l.trim() !== '').length,
        sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      },
      body,
    })
  })

  const lens = chapters.map((c) => c.entry.chars)
  const sum = lens.reduce((a, b) => a + b, 0)

  return {
    manifest: {
      schema: 1,
      work: '',
      stats: {
        chapters: chapters.length,
        totalChars: sum,
        minChars: Math.min(...lens),
        maxChars: Math.max(...lens),
        avgChars: Math.round(sum / chapters.length),
      },
      frontMatter,
      volumes: lines.filter((l) => VOLUME_RE.test(l)).map((l) => l.trim()),
      rejectedHeadings: rejected,
      numberingStatus: breaks.length === 0 ? 'clean' : 'irregular',
      numberingBreaks: breaks,
      excluded: [],
      chapters: chapters.map((c) => c.entry),
    },
    chapters,
  }
}

/** 把切分结果落盘：chapters/*.md + manifest.json。 */
export function writeSplit(workDir, workName, source, result) {
  mkdirSync(join(workDir, 'chapters'), { recursive: true })
  for (const { entry, body } of result.chapters) {
    writeFileSync(join(workDir, entry.file), body, 'utf8')
  }
  const manifest = { ...result.manifest, work: workName, source, generatedAt: new Date().toISOString() }
  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}
