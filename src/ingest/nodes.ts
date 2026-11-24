/**
 * 节点表第一遍（规则扫描）—— **诊断用，不是生产路径**。
 *
 * 从 nodes.ps1 迁到 TypeScript，保留它是为了复现一个结论：
 * 规则扫描在本作上召回率约 6.8%（方少云全文出现 13,127 次，规则只命中 888；
 * 彭风/小雨/楚南行/纳兰容容 全部为 0），因此**不能**作为 `entities_new` 的判据。
 *
 * 根因：本作对话大量不带说话人标记（"彭风说：" 全文只出现 3 次），
 * 基于「名字 + 说/道」的模式必然漏。
 *
 * 生产路径已改为**顺序单遍**：逐章抽取并递推累积节点表（见 index.js 的 novel_ingest）。
 *
 * 用法：
 *   node src/ingest/nodes.ts --chapters <chapters 目录> --out <nodes.json> [--min 8]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 一个候选节点。 */
export interface NodeEntry {
  id: string
  name: string
  kind: 'person' | 'place' | 'org' | 'item' | 'concept'
  count: number
  firstChapter: number
  chapters: number
  aliases: string[]
}

/** 扫描产物。 */
export interface NodeScanResult {
  schema: 1
  pass: 'rule-v1'
  status: 'diagnostic' | 'rejected'
  reason?: string
  generatedAt: string
  params: { minCount: number; chaptersScanned: number }
  stats: { total: number; person: number; org: number }
  nodes: NodeEntry[]
}

/** 中文虚词/代词黑名单：避免「我们说道」被抓成人物。 */
const CN_STOP = new Set([
  '我们', '他们', '你们', '她们', '自己', '大家', '人家', '别人', '这个', '那个', '哪个',
  '什么', '怎么', '这样', '那样', '这些', '那些', '一个', '一些', '两个', '三个', '几个',
  '有的', '没有', '就是', '可是', '但是', '然后', '于是', '所以', '因为', '如果', '虽然',
  '不过', '而且', '并且', '现在', '已经', '还是', '只是', '时候', '事情', '东西', '心里',
  '脸上', '声音', '忽然', '突然', '立刻', '马上', '一下', '一边', '一直', '起来', '出来',
  '过来', '进去', '回去', '知道', '觉得', '认为', '以为', '看着', '听着', '想着', '说着',
  '笑着', '跟着', '对着', '冲着', '朝着', '向着', '由于', '关于', '对于', '至于', '甚至',
  '反正', '果然', '居然', '竟然', '当然', '一会', '一阵', '一句', '一声', '一样', '一定',
  '一般', '有人', '没人', '怎样', '如何', '这时', '那时', '此时', '当时', '两人', '三人',
  '众人', '所有人', '这几个', '那几个', '不少人', '很多人', '每个人', '一个人',
])

/** 英文缩写/游戏术语黑名单。 */
const ASCII_STOP = new Set([
  'GG', 'SCV', 'Drone', 'Zerg', 'Protoss', 'Terran', 'Bunker', 'Rush', 'VOD', 'CPL', 'WCG',
  'BBS', 'QQ', 'NBA', 'SM', 'PC', 'CS', 'ID', 'MM', 'FP', 'OK', 'TNND', 'NND', 'MU', 'TV',
  'DVD', 'CD', 'MB', 'GB', 'Hunter', 'Rep',
])

const RE_CN_ACTION = /([\u4e00-\u9fa5]{2,3})(?:说|道|笑|问|答|骂|吼|喊|叹|点头|摇头|冷笑)/g
const RE_CN_POSSESS = /([\u4e00-\u9fa5]{2,3})的(?:脸|手|眼|声音|心里|脑袋|屁股|眼神|嘴角|身体)/g
const RE_ASCII = /(?<![A-Za-z0-9_])([A-Z_][A-Za-z0-9_]{2,15})(?![A-Za-z0-9_])/g
const RE_ORG = /([\u4e00-\u9fa5]{2,6})(战队|网吧|俱乐部|大学|学院|公司|集团|企业|联赛)/g

/** 扫描一章文本，返回候选名字与出现次数。 */
export function scanChapter(text: string): Map<string, { count: number; kind: NodeEntry['kind'] }> {
  const hits = new Map<string, { count: number; kind: NodeEntry['kind'] }>()
  const bump = (name: string, kind: NodeEntry['kind']): void => {
    if (!name || name.length < 2) return
    if (CN_STOP.has(name)) return
    if (ASCII_STOP.has(name)) return
    const cur = hits.get(name)
    if (cur) {
      cur.count += 1
      if (kind === 'org') cur.kind = 'org'
    } else {
      hits.set(name, { count: 1, kind })
    }
  }

  for (const m of text.matchAll(RE_CN_ACTION)) bump(m[1] as string, 'person')
  for (const m of text.matchAll(RE_CN_POSSESS)) bump(m[1] as string, 'person')
  for (const m of text.matchAll(RE_ASCII)) bump(m[1] as string, 'person')
  for (const m of text.matchAll(RE_ORG)) bump(`${m[1]}${m[2]}`, 'org')
  return hits
}

/** 扫描整个 chapters 目录，产出节点表。 */
export function scanDirectory(chapterDir: string, minCount = 8): NodeScanResult {
  const files = readdirSync(chapterDir).filter((f) => /^ch\d+\.md$/.test(f)).sort()
  const stat = new Map<string, { count: number; first: number; chapters: Set<number>; kind: NodeEntry['kind'] }>()

  for (const f of files) {
    const chapter = Number.parseInt(f.replace(/\D/g, ''), 10)
    const text = readFileSync(join(chapterDir, f), 'utf8')
    for (const [name, info] of scanChapter(text)) {
      const cur = stat.get(name)
      if (cur) {
        cur.count += info.count
        cur.chapters.add(chapter)
        if (info.kind === 'org') cur.kind = 'org'
      } else {
        stat.set(name, { count: info.count, first: chapter, chapters: new Set([chapter]), kind: info.kind })
      }
    }
  }

  const nodes: NodeEntry[] = [...stat.entries()]
    .filter(([, v]) => v.count >= minCount)
    .sort((a, b) => a[1].first - b[1].first || a[0].localeCompare(b[0]))
    .map(([name, v], i) => ({
      id: `n${String(i + 1).padStart(4, '0')}`,
      name,
      kind: v.kind,
      count: v.count,
      firstChapter: v.first,
      chapters: v.chapters.size,
      aliases: [],
    }))

  return {
    schema: 1,
    pass: 'rule-v1',
    status: 'diagnostic',
    reason: '召回率约 6.8%，不足以支撑 entities_new 判定；仅供参考，勿作为依赖',
    generatedAt: new Date().toISOString(),
    params: { minCount, chaptersScanned: files.length },
    stats: {
      total: nodes.length,
      person: nodes.filter((n) => n.kind === 'person').length,
      org: nodes.filter((n) => n.kind === 'org').length,
    },
    nodes,
  }
}

/** 命令行入口。 */
export function main(argv: string[]): number {
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const chapters = arg('--chapters')
  const out = arg('--out')
  if (!chapters || !out) {
    console.error('用法: node src/ingest/nodes.ts --chapters <目录> --out <nodes.json> [--min 8]')
    return 2
  }
  const dir = resolve(chapters)
  if (!existsSync(dir)) {
    console.error(`找不到目录: ${dir}`)
    return 2
  }
  const result = scanDirectory(dir, Number(arg('--min') ?? 8))
  writeFileSync(resolve(out), JSON.stringify(result, null, 2), 'utf8')
  console.log(`扫描章节 = ${result.params.chaptersScanned}`)
  console.log(`候选节点 = ${result.stats.total}（person=${result.stats.person} org=${result.stats.org}）`)
  console.log('注意：规则扫描召回不足，此产物仅作诊断，不进入生产路径。')
  const top = [...result.nodes].sort((a, b) => b.count - a.count).slice(0, 10)
  for (const n of top) console.log(`  ${n.name.padEnd(12)} ${n.kind.padEnd(6)} ${n.count}`)
  return 0
}

if (process.argv[1]?.endsWith('nodes.ts')) process.exit(main(process.argv.slice(2)))
