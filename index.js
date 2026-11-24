// 网文续写助手 · Host 插件入口
//
// 工具契约（packages/core/tools/src/index.ts）：
//   { name, description, parameters, output: { schema, render }, execute(args, exec) }
//
// 模型：不配置。provider/model 留空时继承 DSH 当前路由，链条与 dsh-compaction-basic 一致：
//   显式配置 > 会话最近一次请求的路由 > agent.options
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadCards, validateCard, deriveGraph, buildBible, buildSynopsis, buildScreenplay,
  renderCard, estTokens, computeDensity, PACK_FIELDS, ENUMS,
  splitForExtraction, mergePartCards, enforceStorageBudget,
} from './src/core/workflow.mjs'
import { decodeSource, splitNovel, writeSplit } from './src/core/split.mjs'

export const inject = ['tools', 'llm']

const DEFAULTS = {
  novelDir: '',
  recentChapters: 3,
  bibleTokenBudget: 3000,
  provider: '',   // 留空 = 继承
  model: '',      // 留空 = 继承
  // 注入层：只在 cwd 命中前缀的会话里注入最近 N 章，避免污染其他会话
  autoInject: false,
  autoInjectCwdPrefix: '',
  autoInjectSubagents: false,
  chunkChars: 4000,
  novelsRoot: '',   // 作品根目录；留空则取 novelDir 的父目录
}

const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
const objSchema = { type: 'object' }

const EXTRACT_SYSTEM = `你是小说结构化抽取器。只输出一个 JSON 对象，不要 markdown 代码块，不要解释。
字段：{"density":0-1,"time":{"story":"","span":"","mode":"linear|flashback|timeskip"},"pov":[],"location":[],"beats":["≤30字，最多6条"],"entities_new":[{"name":"","kind":"person|place|org|item|concept","tag":"≤12字"}],"relations":[{"a":"","rel":"kin|friend|ally|hostile|rival|lover|mentor|subordinate|acquaint","b":"","since":章号}],"state_changes":[{"subject":"","field":"relationship|identity|location|power|possession|health|status","from":"","to":"","cause":"因何而变：谁做的、因什么事，≤20字"}],"items":[{"name":"","change":"","holder":""}],"reveals":[{"who":"","fact":""}],"foreshadow":{"planted":[],"paid":[]},"hook":{"text":"","type":"cliffhanger|reveal|reversal|quiet"},"ext":{},"contentRedactions":[{"startLine":0,"endLine":0,"reason":"l2-sexual-content"}]}
规则：
1. entities_new 只列本章首次出现的；已在「已知实体」里的不要重复。
2. density 衡量信息增量（新增实体+状态变化+新伏笔+不可逆事件）/章字数，与剧情好不好看无关。
3. 内容策略：若本章含性行为过程描写（L2），不记录其内容，beats 只写一句占位事实，并在 contentRedactions 记行区间；暗示或淡出（L1）正常记录。
3b. state_changes 必须带 cause：写清「为什么变」（谁做的、因什么事）。原文只作为背景交代的变化（例如「此前被某人打入败者组」）也要记成一条 state_change，cause 写清来源。
4. ext 只填已启用的 pack：urban 用 {"goal":[],"rank":[],"rival":[]}，romance 用 {"affect":[],"misunderstanding":[]}。无内容留空对象。
4b. foreshadow.paid 只能填**前面章节已埋伏笔的原话**（用于标记回收）。不要写本章自身的因果、动机或背景描述——那属于 beats 或 state_changes.cause。没有真正回收的就留空数组。`

const SCENES_SYSTEM = `你是场次拆解器。读一章小说正文，只输出一个 JSON 数组，不要 markdown 代码块，不要解释。
每个元素：{"place":"正文里出现的地点名","time":"本章内的时段","mode":"linear|flashback|timeskip","people":["在场人物名"],"conflict":"这一场的冲突或目的，≤30字","result":"这一场的结果或变化，≤30字","kind":"setup|develop|turn"}
要求：
1. 按时间顺序；一个连续时空算一场。
2. **必须覆盖全章**：开头与结尾各至少一场，不许跳过章首或章末的短场。
3. place 必须取自正文里真实出现的地点，越具体越好（如"教学楼·历史课"优于"学校"）；不要编。
4. people 只写人名，绝不写网吧、食堂、学校这类场所名。
5. conflict 写"谁要什么、卡在哪"，result 写"最后落成什么"，两句都不要复述对方。
6. mode：正常叙事用 linear；**叙述者插叙/回忆/往事用 flashback**；时间跳跃用 timeskip。插叙必须单独成场，不要并进相邻的正叙场。
7. 一般 4–8 场，最多 10 场。`

const CONTINUE_SYSTEM = `你是续写策划。输入是「前情状态」+「最近章节」+「用户想写的主题」，你要先做一致性校验，再产出续写简报。
只输出一个 JSON 对象，不要 markdown 代码块，不要解释。

判定口径：
- 只报**硬矛盾**：已死亡/已退场角色出场；已知重伤或受限状态下做不可能的动作；时间线与已发生事件冲突；已明确终结的关系被当成存续；与已揭示事实直接相反。
- **冲突必须能引用「前情状态」或「最近章节」里的原句作为依据。** 凡是靠你自己推断出来的（赛制细节、人物阵营归属、名额归属），一律写进「需澄清」，不得判为 conflict。
- 不要报"有难度""可能不合理""读者可能不喜欢"这类软问题。
- 主题里有歧义（如"比赛"未说明是足球赛还是星际赛），不算冲突，写进 brief 的"需澄清"。

输出格式（二选一）：
{"status":"conflict","conflicts":[{"detail":"冲突点","evidence":"前情里的依据"}]}
{"status":"ok","brief":{"承接":"从哪一章的什么状态接下去","目标":"这一段落要达成的叙事效果","必须维持":["..."],"禁止":["..."],"需澄清":["..."],"建议篇幅":"约 N 字"}}`

const paths = (dir) => ({
  manifest: path.join(dir, 'manifest.json'),
  cards: path.join(dir, 'cards'),
  chapters: path.join(dir, 'chapters'),
  scenes: path.join(dir, 'scenes'),
  synopses: path.join(dir, 'synopses'),
})

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2))
}

function extractTarget(agent, config) {
  const latest = agent?.session?.requestHeader?.()?.config
  const configured = config.provider && config.model ? { provider: config.provider, model: config.model } : undefined
  const agentTarget = agent?.options?.provider && agent?.options?.model
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  return configured ?? latest ?? agentTarget
}

/**
 * 归一化 ext：模型经常把副字段拍平成 {goal,rank,rival} 而不是 {urban:{...}}。
 * 按字段归属把散落的键塞回对应 pack，避免整章因 schema 校验失败。
 */
/** 枚举纠偏：模型常把 acquaint 写成 acquain、person 写成 Person 之类。 */
function coerceEnum(value, allowed) {
  if (allowed.includes(value)) return value
  const v = String(value ?? '').toLowerCase().trim()
  if (!v) return allowed[0]
  const exact = allowed.find((a) => a.toLowerCase() === v)
  if (exact) return exact
  const pref = allowed.find((a) => a.toLowerCase().startsWith(v) || v.startsWith(a.toLowerCase()))
  return pref ?? allowed[0]
}

function normalizeExt(ext) {
  const out = {}
  const owner = {}
  for (const [pack, fields] of Object.entries(PACK_FIELDS)) {
    for (const f of fields) if (!(f in owner)) owner[f] = pack
  }
  for (const [k, v] of Object.entries(ext ?? {})) {
    if (PACK_FIELDS[k]) { out[k] = v; continue }
    const pack = owner[k]
    if (!pack) continue
    out[pack] = { ...(out[pack] ?? {}), [k]: v }
  }
  for (const [pack, v] of Object.entries(out)) {
    if (!v || typeof v !== 'object' || Object.keys(v).length === 0) delete out[pack]
  }
  return out
}

function parseCardText(raw, ch) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里找不到 JSON 对象')
  const o = JSON.parse(raw.slice(start, end + 1))
  const E = ENUMS
  return {
    schema: 2,
    chapter: ch.chapter,
    title: ch.title,
    source: { file: ch.file, chars: ch.chars, density: typeof o.density === 'number' ? o.density : 0.5 },
    time: {
      story: o.time?.story ?? '',
      span: o.time?.span ?? '',
      mode: coerceEnum(o.time?.mode ?? 'linear', E.timeMode),
    },
    pov: o.pov ?? [],
    location: o.location ?? [],
    beats: o.beats ?? [],
    entities_new: (o.entities_new ?? []).map((e) => ({
      name: e.name,
      kind: coerceEnum(e.kind, E.kind),
      tag: typeof e.tag === 'string' ? e.tag.slice(0, 12) : undefined,
    })),
    relations: (o.relations ?? []).map((r) => ({
      a: r.a, b: r.b, since: r.since, rel: coerceEnum(r.rel, E.rel),
    })),
    state_changes: (o.state_changes ?? []).map((s) => ({
      subject: s.subject, from: s.from, to: s.to, cause: s.cause, field: coerceEnum(s.field, E.stateField),
    })),
    items: o.items ?? [],
    reveals: o.reveals ?? [],
    foreshadow: o.foreshadow ?? { planted: [], paid: [] },
    hook: { text: o.hook?.text ?? '', type: coerceEnum(o.hook?.type ?? 'quiet', E.hookType) },
    ext: normalizeExt(o.ext),
    contentRedactions: o.contentRedactions ?? [],
  }
}

function extractPrompt(ch, body, known) {
  return `第 ${ch.chapter} 章《${ch.title}》，正文 ${ch.chars} 字。
已知实体（不要重复计入 entities_new）：${known.slice(0, 300).join('、') || '（无）'}
=== 正文开始 ===
${body}
=== 正文结束 ===`
}

/** 插件包根目录，用于解析相对的 novelDir（跨机器可移植）。 */
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * novelDir 支持两种写法：
 *   相对路径 → 相对插件包根解析（推荐，跨机器可移植）
 *   绝对路径 → 原样使用（用户 patch 层的常见写法）
 * 留空时插件待命、不注册任何工具（生产闸门要求的行为）。
 */
function resolveNovelDir(input) {
  const p = String(input ?? '')
  if (!p) return ''
  return path.isAbsolute(p) ? p : path.resolve(PKG_DIR, p)
}

/**
 * 在目录里找候选 txt（浅扫两层），跳过产物/依赖/数据/插件自身目录。
 * 用于"用户把 txt 丢进工作区，插件自动发现并转存"。
 */
function discoverTextFiles(root, maxDepth = 2) {
  const SKIP = new Set([
    'novels', 'releases', 'dist', 'node_modules', '.git', '.scale-sim', 'related',
    'sanitize', 'docs', 'scripts', 'reference', 'src', 'locale',
  ])
  const found = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    // 插件包自身目录永远不算"用户拖进来的稿子"
    if (path.resolve(dir).startsWith(PKG_DIR)) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue
        walk(full, depth + 1)
      } else if (e.isFile() && /\.txt$/i.test(e.name)) {
        found.push(full)
      }
    }
  }
  // 只在工作区不是插件包内部时才扫
  if (root && fs.existsSync(root) && !path.resolve(root).startsWith(PKG_DIR)) walk(root, 0)
  return found.sort()
}

/** 作品名清洗：去掉路径分隔符与 Windows 非法字符。 */
function sanitizeWorkName(name) {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名作品'
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }

  const novelDir = resolveNovelDir(config.novelDir)
  if (!novelDir) {
    ctx.logger?.info?.('[novel-helper] novelDir 未配置，插件待命（请在 patch 里指定作品目录）')
    return
  }
  if (!fs.existsSync(novelDir)) {
    ctx.logger?.warn?.(`[novel-helper] novelDir 不存在：${novelDir}`)
    return
  }
  const P = paths(novelDir)

  /** 作品根目录：导入把新作品放到这里。 */
  const NOVELS_ROOT = config.novelsRoot
    ? resolveNovelDir(config.novelsRoot)
    : path.dirname(novelDir)

  /**
   * 把一个 txt 导入为作品目录：source/ 存原文副本与来源元数据，再切分成 chapters/ + manifest。
   * 幂等：目标目录已有同源 manifest 时跳过。
   */
  const importOne = (file, opts = {}) => {
    const bytes = fs.readFileSync(file)
    const { text, encoding } = decodeSource(bytes)
    let result
    try {
      result = splitNovel(text)
    } catch (err) {
      return { file, status: 'skipped', reason: String(err?.message ?? err) }
    }
    const workName = sanitizeWorkName(opts.name ?? path.basename(file, path.extname(file)))
    const dest = path.join(NOVELS_ROOT, workName)
    const sourceDir = path.join(dest, 'source')
    const originPath = path.join(sourceDir, 'origin.json')
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    if (fs.existsSync(originPath) && !opts.force) {
      try {
        const prev = JSON.parse(fs.readFileSync(originPath, 'utf8'))
        if (prev.sha256 === sha256) {
          return { file, status: 'exists', work: workName, dir: dest, chapters: prev.chapters }
        }
      } catch { /* 元数据坏了就重导 */ }
    }

    fs.mkdirSync(sourceDir, { recursive: true })
    // 原文规范化副本（UTF-8 / LF），保留可追溯性
    fs.writeFileSync(path.join(sourceDir, 'full.txt'), text.replace(/\r\n/g, '\n'), 'utf8')
    const crlf = (text.match(/\r\n/g) ?? []).length
    writeSplit(dest, workName, {
      path: path.basename(file),
      encoding,
      lineEnding: crlf > 0 ? 'CRLF' : 'LF',
      rawLines: text.split(/\r\n|\n/).length,
    }, result)
    fs.writeFileSync(originPath, JSON.stringify({
      originalPath: file,
      originalName: path.basename(file),
      encoding,
      bytes: bytes.length,
      sha256,
      chapters: result.chapters.length,
      importedAt: new Date().toISOString(),
    }, null, 2), 'utf8')

    if (opts.move) { try { fs.unlinkSync(file) } catch { /* 保留原件更安全 */ } }

    return {
      file,
      status: 'imported',
      work: workName,
      dir: dest,
      chapters: result.chapters.length,
      chars: result.manifest.stats.totalChars,
      encoding,
      numberingStatus: result.manifest.numberingStatus,
      breaks: result.manifest.numberingBreaks.length,
    }
  }

  // ---- 导入：先提议，用户确认后才写盘 ----
  ctx.effect(() => ctx.tools.register({
    name: 'novel_import',
    description: '处理用户提供的 txt 小说：**默认只做提议（dryRun），不写盘**。先用默认参数调用，把 detectedFiles / 章节数 / 编码 / 目标目录 报告给用户并询问是否导入；用户明确同意后，再带 confirm:true 重新调用才真正转存并切分。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '单个 txt 路径或目录；缺省则扫描当前工作区' },
        name: { type: 'string', description: '作品名（缺省用文件名）' },
        move: { type: 'boolean', description: '导入后是否删除原文件（默认 false，保留更安全）' },
        force: { type: 'boolean', description: '同源已存在时也重新导入' },
        scan: { type: 'boolean', description: '未给 path 时是否扫描（默认 true）' },
        confirm: { type: 'boolean', description: '必须显式为 true 才真正写盘；缺省只返回提议' },
      },
    },
    output: { schema: objSchema, render: (_a, v) => text(v) },
    async execute(args = {}, exec) {
      const targets = []
      if (args.path) {
        const p = path.resolve(args.path)
        if (!fs.existsSync(p)) throw new Error(`路径不存在：${p}`)
        if (fs.statSync(p).isDirectory()) targets.push(...discoverTextFiles(p))
        else targets.push(p)
      } else if (args.scan !== false) {
        const cwd = String(exec?.agent?.session?.header?.cwd ?? process.cwd())
        targets.push(...discoverTextFiles(cwd))
      }
      if (!targets.length) return { scanned: 0, imported: [], skipped: [], note: '没有找到 txt 文件' }

      // 提议模式：只探测，不写盘
      if (args.confirm !== true) {
        const proposals = []
        for (const file of targets) {
          try {
            const bytes = fs.readFileSync(file)
            const { text, encoding } = decodeSource(bytes)
            const result = splitNovel(text)
            const workName = sanitizeWorkName(args.name ?? path.basename(file, path.extname(file)))
            const dest = path.join(NOVELS_ROOT, workName)
            const originPath = path.join(dest, 'source', 'origin.json')
            let already = false
            try {
              already = fs.existsSync(originPath)
                && JSON.parse(fs.readFileSync(originPath, 'utf8')).sha256 === createHash('sha256').update(bytes).digest('hex')
            } catch { /* 元数据缺失按未导入处理 */ }
            proposals.push({
              file,
              work: workName,
              dest,
              encoding,
              bytes: bytes.length,
              chapters: result.chapters.length,
              chars: result.manifest.stats.totalChars,
              numberingStatus: result.manifest.numberingStatus,
              numberingBreaks: result.manifest.numberingBreaks.length,
              alreadyImported: already,
            })
          } catch (err) {
            proposals.push({ file, status: 'not-a-novel', reason: String(err?.message ?? err) })
          }
        }
        const importable = proposals.filter((p) => p.chapters && !p.alreadyImported)
        return {
          mode: 'proposal',
          novelsRoot: NOVELS_ROOT,
          detectedFiles: proposals,
          willImport: importable.length,
          askUser: importable.length
            ? `检测到 ${importable.length} 个可导入的 txt。是否把它们转存并切分到 ${NOVELS_ROOT}？确认后我再用 confirm:true 执行。`
            : '没有需要导入的新文件。',
          note: '当前是提议模式，未写入任何文件。',
        }
      }

      const imported = []
      const skipped = []
      for (const file of targets) {
        const r = importOne(file, { name: args.name, move: args.move, force: args.force })
        if (r.status === 'imported' || r.status === 'exists') imported.push(r)
        else skipped.push(r)
      }
      return {
        mode: 'applied',
        scanned: targets.length,
        imported,
        skipped,
        novelsRoot: NOVELS_ROOT,
        next: imported.some((i) => i.status === 'imported')
          ? '已切分。要抽卡片请调 novel_ingest（继承当前模型路由）；要让插件默认使用某部作品，把 novelDir 指向它的目录。'
          : '没有新作品需要导入。',
      }
    },
  }))

  const load = () => {
    if (!fs.existsSync(P.manifest)) throw new Error(`找不到 manifest.json：${P.manifest}`)
    const manifest = readJson(P.manifest)
    const cards = fs.existsSync(P.cards) ? loadCards(P.cards) : []
    return { manifest, cards }
  }

  // ---- 逐章抽取（顺序单遍，唯一需要模型的工具）----
  ctx.effect(() => ctx.tools.register({
    name: 'novel_ingest',
    description: '逐章抽取卡片（顺序单遍，累积节点表）。不需要配置模型：自动继承当前会话在用的路由。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'integer', minimum: 1 },
        to: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        estimateOnly: { type: 'boolean' },
      },
    },
    output: { schema: objSchema, render: (_a, v) => text(v) },
    async execute(args = {}, exec) {
      const agent = exec?.agent
      const target = extractTarget(agent, config)
      if (!target?.provider || !target?.model) {
        throw new Error('拿不到当前模型路由：请在 DSH 里正常发一次消息后再试，或显式配置 provider/model')
      }

      const { manifest } = load()
      const already = new Set(load().cards.map((c) => c.chapter))
      const from = args.from ?? 1
      const to = args.to ?? manifest.chapters.length
      const limit = args.limit ?? 3
      const todo = manifest.chapters
        .filter((c) => c.chapter >= from && c.chapter <= to && !already.has(c.chapter))
        .slice(0, limit)

      const estimate = {
        target,
        pending: todo.length,
        chars: todo.reduce((s, c) => s + c.chars, 0),
        roughTokens: Math.round(todo.reduce((s, c) => s + c.chars, 0) / 1.6),
      }
      if (args.estimateOnly || todo.length === 0) return estimate

      const known = new Set([
        ...load().cards.flatMap((c) => (c.entities_new ?? []).map((e) => e.name)),
      ])

      const done = []
      const failed = []
      for (const ch of todo) {
        const file = path.join(P.chapters, path.basename(ch.file))
        if (!fs.existsSync(file)) { failed.push({ chapter: ch.chapter, reason: 'chapter file missing' }); continue }
        const body = fs.readFileSync(file, 'utf8')
        let lastError = ''
        let ok = false
        // 长章切段：ch84（6194 字）单次调用连续失败过两次，分段后每段输出可控
        const parts = splitForExtraction(body, config.chunkChars ?? 4000)
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          try {
            const retryHint = attempt === 1
              ? ''
              : `\n\n【重试】上次输出不合法（${lastError}）。只输出一个 JSON 对象，不要换行以外的任何文字，不要 markdown 代码块，确保 JSON 完整闭合。`
            const partCards = []
            for (const part of parts) {
              const partNote = part.total > 1
                ? `\n\n【分段】本章较长，按段落切为 ${part.total} 段，这是第 ${part.index} 段。只抽取本段内容；不确定的字段留空。`
                : ''
              let out = ''
              const stream = ctx.llm.stream({
                provider: target.provider,
                model: target.model,
                system: EXTRACT_SYSTEM,
                messages: [{ role: 'user', content: [{ type: 'text', text: extractPrompt(ch, part.text, [...known]) + partNote + retryHint }] }],
                maxTokens: 6000,
                ...(agent?.session?.id ? { sessionId: agent.session.id } : {}),
                ...(exec?.signal ? { signal: exec.signal } : {}),
              })
              for await (const chunk of stream) {
                if (chunk.type === 'text-delta') out += chunk.text
              }
              partCards.push(parseCardText(out, ch))
            }
            const card = parts.length === 1
              ? partCards[0]
              : mergePartCards(partCards, { chapter: ch.chapter, title: ch.title, source: { file: ch.file, chars: ch.chars } })
            card.chapter = ch.chapter
            card.title = ch.title
            card.source = { file: ch.file, chars: ch.chars, density: computeDensity(card) }
            const capped = enforceStorageBudget(card)
            const issues = validateCard(capped)
            if (issues.length) { lastError = issues.join('; '); continue }
            writeJson(path.join(P.cards, `ch${String(ch.chapter).padStart(4, '0')}.json`), capped)
            for (const e of capped.entities_new ?? []) known.add(e.name)
            done.push({ chapter: ch.chapter, beats: capped.beats.length, density: capped.source.density, parts: parts.length, attempts: attempt })
            ok = true
          } catch (err) {
            lastError = String(err?.message ?? err)
          }
        }
        if (!ok) failed.push({ chapter: ch.chapter, reason: lastError })
      }
      return { ...estimate, done, failed }
    },
  }))

  // ---- 状态 ----
  ctx.effect(() => ctx.tools.register({
    name: 'novel_status',
    description: '查看摄取进度、卡片统计、关系图规模与注入预算占用。只读，不触发模型调用。',
    parameters: objSchema,
    output: { schema: objSchema, render: (_a, v) => text(v) },
    async execute(_args = {}, exec) {
      const { manifest, cards } = load()
      const graph = deriveGraph(cards)
      // 工作区里还没导入的 txt：让"丢文件进来"这件事能被感知
      const cwd = String(exec?.agent?.session?.header?.cwd ?? process.cwd())
      const known = new Set(
        fs.existsSync(NOVELS_ROOT)
          ? fs.readdirSync(NOVELS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
          : [],
      )
      const pending = discoverTextFiles(cwd)
        .map((f) => ({ file: f, name: path.basename(f, path.extname(f)) }))
        .filter((f) => !known.has(sanitizeWorkName(f.name)))
        // 只报"真的能切出章节"的文件，避免把配置/笔记类 txt 也报成待导入
        .filter((f) => {
          try {
            const { text } = decodeSource(fs.readFileSync(f.file))
            return splitNovel(text).chapters.length > 0
          } catch {
            return false
          }
        })
      return {
        work: manifest.work,
        chapters: manifest.chapters.length,
        extracted: cards.length,
        numberingStatus: manifest.numberingStatus,
        numberingBreaks: (manifest.numberingBreaks ?? []).length,
        graph: { nodes: graph.nodes.length, edges: graph.edges.length },
        pendingTexts: pending,
        renders: cards.map((c) => {
          const r = renderCard(c)
          return { chapter: c.chapter, tokens: r.tokens, budget: r.budget.inject, trimmed: r.trimmed }
        }),
      }
    },
  }))

  // ---- 按章取上下文 ----
  ctx.effect(() => ctx.tools.register({
    name: 'novel_context',
    description: '按章范围取回已渲染的卡片上下文（注入态，含超预算裁剪）。只读。',
    parameters: {
      type: 'object',
      properties: { from: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 } },
      required: ['from', 'to'],
    },
    output: { schema: objSchema, render: (_a, v) => text(v.blocks.join('\n\n')) },
    async execute(args) {
      const { cards } = load()
      const picked = cards.filter((c) => c.chapter >= args.from && c.chapter <= args.to)
      const rendered = picked.map((c) => renderCard(c))
      return {
        chapters: picked.map((c) => c.chapter),
        blocks: rendered.map((r) => r.text),
        tokens: rendered.reduce((s, r) => s + r.tokens, 0),
      }
    },
  }))

  // ---- 续写：主题 → 一致性闸门 → 续写简报 ----
  ctx.effect(() => ctx.tools.register({
    name: 'novel_continue',
    description: '按主题出续写简报。先与前文状态做一致性校验：有硬矛盾就拒答并列冲突，不出简报；通过才给可执行指令（承接点/必守设定/禁止项/篇幅）。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '想写什么，例如"后续比赛：方少云战绩一般，不详写对战细节"' },
        avoid: { type: 'array', items: { type: 'string' }, description: '明确不想写的内容' },
        from: { type: 'integer', minimum: 1, description: '从第几章之后接（默认最后一章）' },
        length: { type: 'integer', minimum: 300, maximum: 5000, description: '期望字数' },
      },
      required: ['topic'],
    },
    output: { schema: objSchema, render: (_a, v) => text(v) },
    async execute(args = {}, exec) {
      const agent = exec?.agent
      const target = extractTarget(agent, config)
      if (!target?.provider) throw new Error('拿不到当前模型路由')

      const { cards } = load()
      if (!cards.length) throw new Error('还没有已抽取的卡片')
      const sorted = [...cards].sort((a, b) => a.chapter - b.chapter)
      const cut = args.from ?? sorted[sorted.length - 1].chapter
      const upTo = sorted.filter((c) => c.chapter <= cut)
      const recent = upTo.slice(-3)
      const bible = buildBible(upTo, deriveGraph(upTo))

      const stateLines = []
      for (const c of upTo) {
        for (const s of c.state_changes ?? []) stateLines.push(`第${c.chapter}章 ${s.subject}.${s.field}: ${s.from} → ${s.to}` + (s.cause ? `（因：${s.cause}）` : ''))
      }
      const openThreads = bible.openThreads.filter((t) => t.status === 'open').map((t) => `第${t.chapter}章 ${t.desc}`)

      const payload = [
        `## 前情状态（截至第 ${cut} 章）`,
        stateLines.slice(-40).join('\n') || '（无记录）',
        '',
        '## 未回收伏笔',
        openThreads.slice(-25).join('\n') || '（无）',
        '',
        '## 最近 ${recent.length} 章',
        recent.map((c) => `第${c.chapter}章｜${(c.location || []).join('、')}\n` + (c.beats || []).map((b) => '· ' + b).join('\n')).join('\n\n'),
        '',
        '## 用户想写的主题',
        args.topic,
        args.avoid?.length ? '\n## 明确不想写\n' + args.avoid.map((a) => '- ' + a).join('\n') : '',
        args.length ? `\n## 期望字数\n约 ${args.length} 字` : '',
      ].join('\n')

      let out = ''
      const stream = ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        system: CONTINUE_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: payload }] }],
        maxTokens: 2000,
        ...(agent?.session?.id ? { sessionId: agent.session.id } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
      })
      for await (const chunk of stream) if (chunk.type === 'text-delta') out += chunk.text

      const a = out.indexOf('{')
      const b = out.lastIndexOf('}')
      if (a < 0 || b <= a) throw new Error('模型输出里找不到 JSON')
      const parsed = JSON.parse(out.slice(a, b + 1))

      if (parsed.status === 'conflict') {
        return { status: 'conflict', from: cut, conflicts: parsed.conflicts ?? [], blocked: true,
          hint: '存在硬矛盾，未生成简报。请修正主题或先补写过渡，再重新调用。' }
      }
      const clarify = parsed.brief?.需澄清 ?? []
      return {
        status: 'ok',
        from: cut,
        // 模糊不算错，但必须在会话里提示细化——这三条就是该问用户的问题
        needsClarification: clarify.length > 0,
        clarifyQuestions: clarify,
        hint: clarify.length > 0
          ? '主题存在会影响走向的未定点。建议先把 clarifyQuestions 里的问出来再动笔，否则模型会替你选一种，可能不是你想要的。'
          : '主题足够具体，可直接按 brief 写。',
        brief: parsed.brief ?? {},
        stateLines: stateLines.slice(-8),
      }
    },
  }))

  // ---- 场次富化（读原文拆场，供给剧本）----
  ctx.effect(() => ctx.tools.register({
    name: 'novel_scenes',
    description: '读原文拆场次并缓存到 scenes/，供剧本使用。解决"从 beat 推地点会张冠李戴"的问题。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'integer', minimum: 1 },
        to: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    output: { schema: objSchema, render: (_a, v) => text(v) },
    async execute(args = {}, exec) {
      const agent = exec?.agent
      const target = extractTarget(agent, config)
      if (!target?.provider) throw new Error('拿不到当前模型路由')
      const { manifest } = load()
      const have = fs.existsSync(P.scenes)
        ? new Set(fs.readdirSync(P.scenes).map((f) => Number(f.replace(/\D/g, ''))))
        : new Set()
      const todo = manifest.chapters
        .filter((c) => c.chapter >= (args.from ?? 1) && c.chapter <= (args.to ?? manifest.chapters.length))
        .filter((c) => !have.has(c.chapter))
        .slice(0, args.limit ?? 3)
      const done = []
      const failed = []
      for (const ch of todo) {
        const file = path.join(P.chapters, path.basename(ch.file))
        if (!fs.existsSync(file)) { failed.push({ chapter: ch.chapter, reason: 'missing' }); continue }
        const body = fs.readFileSync(file, 'utf8')
        let lastError = ''
        let ok = false
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          try {
            let out = ''
            const stream = ctx.llm.stream({
              provider: target.provider,
              model: target.model,
              system: SCENES_SYSTEM,
              messages: [{ role: 'user', content: [{ type: 'text', text: `第 ${ch.chapter} 章《${ch.title}》\n\n${body}` }] }],
              maxTokens: 6000,
              ...(agent?.session?.id ? { sessionId: agent.session.id } : {}),
              ...(exec?.signal ? { signal: exec.signal } : {}),
            })
            for await (const chunk of stream) if (chunk.type === 'text-delta') out += chunk.text
            const a = out.indexOf('[')
            const b = out.lastIndexOf(']')
            if (a < 0 || b <= a) throw new Error('输出里找不到 JSON 数组')
            const arr = JSON.parse(out.slice(a, b + 1))
            if (!Array.isArray(arr) || !arr.length) throw new Error('场景数组为空')
            writeJson(path.join(P.scenes, `ch${String(ch.chapter).padStart(4, '0')}.json`), arr)
            done.push({ chapter: ch.chapter, scenes: arr.length })
            ok = true
          } catch (err) { lastError = String(err?.message ?? err) }
        }
        if (!ok) failed.push({ chapter: ch.chapter, reason: lastError })
      }
      return { pending: todo.length, done, failed }
    },
  }))

  // ---- 概要 / 剧本 ----
  ctx.effect(() => ctx.tools.register({
    name: 'novel_synopsis',
    description: '导出自包含概要。profile=screenplay 时必须给 from/to 指定单一叙事单元；不提供全书→剧本。',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['compact', 'standard', 'full'] },
        profile: { type: 'string', enum: ['continue', 'screenplay'] },
        from: { type: 'integer', minimum: 1 },
        to: { type: 'integer', minimum: 1 },
      },
    },
    output: { schema: objSchema, render: (_a, v) => text(`已写入 ${v.path}（${v.tokens} token，${v.cards} 章）`) },
    async execute(args = {}) {
      const tier = args.tier ?? 'standard'
      const profile = args.profile ?? 'continue'
      if (profile === 'screenplay' && (args.from === undefined || args.to === undefined)) {
        throw new Error('profile=screenplay 必须给出 from/to；本插件只做单个叙事单元')
      }
      const { cards } = load()
      const scoped = profile === 'screenplay'
        ? cards.filter((c) => c.chapter >= args.from && c.chapter <= args.to)
        : cards
      if (!scoped.length) throw new Error('范围内没有已抽取的卡片')
      const graph = deriveGraph(scoped)
      const bible = buildBible(scoped, graph, { maxChars: config.bibleTokenBudget })
      const scenesByChapter = {}
      if (profile === 'screenplay' && fs.existsSync(P.scenes)) {
        for (const f of fs.readdirSync(P.scenes)) {
          if (!/^ch\d+\.json$/.test(f)) continue
          scenesByChapter[Number(f.replace(/\D/g, ''))] = readJson(path.join(P.scenes, f))
        }
      }
      const md = profile === 'screenplay'
        ? buildScreenplay(bible, scoped, { unitLabel: `第 ${args.from}–${args.to} 章`, scenesByChapter }).md
        : buildSynopsis(bible, scoped, { tier })
      fs.mkdirSync(P.synopses, { recursive: true })
      const outPath = path.join(P.synopses, `synopsis-${profile}-${tier}.md`)
      fs.writeFileSync(outPath, md)
      return { path: outPath, tokens: estTokens(md), cards: scoped.length }
    },
  }))

  // ---- 注入层：仅当用户本轮真的在聊这本书时，才把最近 N 章前情排进上下文 ----
  // cwd 与 origin 都在 agent.session.header 上（agent.meta 是空的）。
  // 只按 cwd 注入会把每次普通技术对话也塞满小说梗概，模型会误以为在做续写任务，
  // 所以再加一道"意图判断"：本轮用户消息里必须提到作品名或续写相关词。
  const injectedSessions = new Set()

  /** 把本轮用户消息拼成纯文本。 */
  const userTextOf = (messages) => (messages ?? [])
    .filter((m) => m?.role === 'user')
    .flatMap((m) => (m.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text))
    .join('\n')

  /**
   * 是否在聊这本书。
   *
   * 默认 **strict**：必须出现作品名或主要人物名。
   * 只用"续写/下一章"这类词会误伤——用户讨论插件本身时也会说"不会产生续写"，
   * 于是被当成了续写请求（实测踩过）。
   *
   * `autoInjectMatch: 'loose'` 可放宽成"意图词命中即可"，但不建议。
   */
  const mentionsNovel = (text, work, names) => {
    if (!text) return false
    const strict = config.autoInjectMatch !== 'loose'
    const hitName = [...names].some((n) => n && n.length >= 2 && text.includes(n))
    if (hitName) return true
    if (strict) return false
    return /续写|接着写|写下去|下一章|第\s*\d+\s*章|梗概|前情|剧本|大纲|人设|伏笔/.test(text)
  }

  /** 作品名 + 主要人物名（按出场章数取前 12），惰性计算一次。 */
  let injectNames = null
  const injectNamesOf = (manifest, cards) => {
    if (injectNames) return injectNames
    const freq = new Map()
    for (const c of cards) {
      for (const e of c.entities_new ?? []) {
        if (e?.kind !== 'person' || !e.name) continue
        freq.set(e.name, (freq.get(e.name) ?? 0) + 1)
      }
      for (const r of c.relations ?? []) {
        for (const n of [r.a, r.b]) if (n) freq.set(n, (freq.get(n) ?? 0) + 1)
      }
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n)
    injectNames = new Set([manifest.work, ...top].filter(Boolean))
    return injectNames
  }

  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    try {
      const sid = agent?.session?.id
      const header = agent?.session?.header ?? {}
      if (config.autoInject && sid && !injectedSessions.has(sid)) {
        const cwd = String(header.cwd ?? '').replace(/\\/g, '/')
        const prefix = String(config.autoInjectCwdPrefix ?? '').replace(/\\/g, '/')
        const isSub = header.origin === 'subagent'
        if (isSub && !config.autoInjectSubagents) {
          injectedSessions.add(sid)
        } else {
          // 隔离判据：配置了前缀且 cwd 已知时要求前缀命中；
          // cwd 缺失（如契约 fixture、无 cwd 的宿主）视为"未知"，不因此拒绝注入。
          const cwdKnown = cwd.length > 0
          const allowed = !prefix || !cwdKnown || cwd.startsWith(prefix)
          if (!allowed) return next()

          const { manifest, cards } = load()
          if (!mentionsNovel(userTextOf(messages), manifest.work, injectNamesOf(manifest, cards))) return next()

          const recent = [...cards].sort((a, b) => a.chapter - b.chapter).slice(-config.recentChapters)
          if (recent.length) {
            const body = recent.map((c) => renderCard(c).text).join('\n\n')
            const head = `【前情】以下是《${manifest.work ?? ''}》最近 ${recent.length} 章的已摄取梗概（第 ${recent[0].chapter}–${recent[recent.length - 1].chapter} 章）。`
              + '\n（这段是背景资料，不是用户请求。若用户当前的请求与本书无关，请忽略本段、照常回答；只有用户确实在写这本书时才以它为依据。）'
            agent.inject({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: head + '\n\n' + body }],
              source: { kind: 'plugin:novel-helper' },
            })
            injectedSessions.add(sid)
          }
        }
      }
    } catch (err) {
      ctx.logger?.warn?.(`[novel-helper] 注入失败：${String(err?.message ?? err)}`)
    }
    return next()
  }))

  ctx.logger?.info?.(`[novel-helper] 已就绪：${novelDir}`)
}
