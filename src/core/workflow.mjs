// 网文续写助手 · 工作流核心
// 纯规则、零模型调用。插件 index.js 与本地验证脚本共用这一份实现。
import fs from 'node:fs'
import path from 'node:path'

// ---------- 受控词表（与设计文档 §5.1 一致） ----------
export const ENUMS = {
  kind: ['person', 'place', 'org', 'item', 'concept'],
  stateField: ['relationship', 'identity', 'location', 'power', 'possession', 'health', 'status'],
  rel: ['kin', 'friend', 'ally', 'hostile', 'rival', 'lover', 'mentor', 'subordinate', 'acquaint'],
  timeMode: ['linear', 'flashback', 'timeskip'],
  hookType: ['cliffhanger', 'reveal', 'reversal', 'quiet'],
  packs: ['urban', 'romance', 'cultivation', 'palace', 'isekai'],
}

export const PACK_FIELDS = {
  urban: ['goal', 'rank', 'rival'],
  romance: ['affect', 'misunderstanding', 'rival', 'promise', 'intimacy'],
  cultivation: ['realm', 'breakthrough', 'artifact', 'sect', 'karma'],
  palace: ['rank', 'faction', 'scheme', 'evidence', 'favor', 'offspring', 'etiquette'],
  isekai: ['geography', 'guild', 'magic', 'currency', 'politics'],
}

// 中文每 token 约 1.6 字（与设计文档口径一致）
export const estTokens = (s) => Math.round(String(s).length / 1.6)

// ---------- 预算分级（§5.1） ----------
export function budgetFor(density) {
  if (density < 0.6) return { storage: 450, inject: 200 }
  if (density <= 0.8) return { storage: 650, inject: 250 }
  return { storage: 950, inject: 300 }
}

/**
 * 确定性密度：从卡片自身的信息增量项算出，不让模型猜。
 *
 * 为什么不按"每千字"归一：density 的用途只有一个——决定卡片预算，
 * 而卡片大小由**证据条目数**决定，不由章字数决定。按字数归一会让
 * 长章被系统性低估、进而被压到低档预算里。这里改用条目数直接标定。
 */
export function computeDensity(card) {
  const evidence = (card.entities_new?.length ?? 0)
    + (card.state_changes?.length ?? 0)
    + (card.items?.length ?? 0)
    + (card.reveals?.length ?? 0)
    + (card.foreshadow?.planted?.length ?? 0)
  const raw = 0.4 + 0.06 * evidence
  return Math.round(Math.min(0.95, Math.max(0.4, raw)) * 100) / 100
}

function bigramsOf(s) {
  const x = String(s).replace(/[\s，。、；：？！「」“”（）()—–\-]/g, '')
  const set = new Set()
  for (let i = 0; i < x.length - 1; i++) set.add(x.slice(i, i + 2))
  return set
}

/** 二元组 Jaccard，用于伏笔标签与描述的粗匹配。 */
export function overlapRatio(a, b) {
  const A = bigramsOf(a)
  const B = bigramsOf(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * M14：自包含扫描。概要/剧本是给外部模型与人的产物，
 * 不得出现内部 ID、卡片文件名、内部产物名或绝对路径。
 */
export function scanSelfContained(md) {
  const hits = []
  const rules = [
    [/cards\//, '引用 cards/ 路径'],
    [/ch\d{4}\.json/, '引用卡片文件名'],
    [/\bF-\d+-\d+\b/, '出现内部伏笔 ID'],
    [/[A-Za-z]:[\\/]/, '出现绝对路径'],
    [/nodes\.json|manifest\.json|bible\.json|graph\.json/, '引用内部产物文件名'],
  ]
  for (const [re, label] of rules) if (re.test(md)) hits.push(label)
  return hits
}


/**
 * 内容策略兜底扫描（M18 的全量版本）。
 *
 * 只做**冒烟检查**：主判据是抽取时的内容判断，不是词表。
 * 词表必然漏（隐喻、代称、纯白描）也必然误伤（战斗场景里的普通动词），
 * 所以命中只意味着"需要人工复核"，不等于违规。
 *
 * @returns 命中次数与命中的词（不返回原文，避免把敏感文本带进报告）
 */
export function scanPolicyTerms(text, terms) {
  const s = String(text)
  const hits = []
  let total = 0
  for (const term of terms) {
    const t = String(term).trim()
    if (!t || t.startsWith('#')) continue
    let idx = 0
    let n = 0
    while ((idx = s.indexOf(t, idx)) !== -1) { n++; idx += t.length }
    if (n > 0) { hits.push({ term: t, count: n }); total += n }
  }
  return { total, hits }
}

// ---------- 载入 ----------
export function loadCards(cardDir) {
  const files = fs.readdirSync(cardDir).filter((f) => /^ch\d+\.json$/.test(f)).sort()
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(cardDir, f), 'utf8')))
}

// ---------- 校验 ----------
export function validateCard(card) {
  const issues = []
  const must = ['schema', 'chapter', 'title', 'source', 'beats']
  for (const k of must) if (!(k in card)) issues.push(`缺少必填字段 ${k}`)

  if (!Array.isArray(card.beats)) issues.push('beats 不是数组')
  else {
    if (card.beats.length > 6) issues.push(`beats 超上限 6（实际 ${card.beats.length}）`)
    card.beats.forEach((b, i) => { if (typeof b !== 'string' || !b.trim()) issues.push(`beats[${i}] 为空`) })
  }

  for (const e of card.entities_new || []) {
    if (!ENUMS.kind.includes(e.kind)) issues.push(`entities_new.kind 非法: ${e.kind}`)
    if (e.tag && e.tag.length > 12) issues.push(`entities_new.tag 超 12 字: ${e.tag}`)
  }
  for (const r of card.relations || []) {
    if (!ENUMS.rel.includes(r.rel)) issues.push(`relations.rel 非法: ${r.rel}`)
    if (!r.a || !r.b) issues.push('relations 缺少 a/b')
  }
  for (const s of card.state_changes || []) {
    if (!ENUMS.stateField.includes(s.field)) issues.push(`state_changes.field 非法: ${s.field}`)
  }
  if (card.time && !ENUMS.timeMode.includes(card.time.mode)) issues.push(`time.mode 非法: ${card.time.mode}`)
  if (card.hook && card.hook.type && !ENUMS.hookType.includes(card.hook.type)) issues.push(`hook.type 非法: ${card.hook.type}`)

  for (const [pack, val] of Object.entries(card.ext || {})) {
    if (!ENUMS.packs.includes(pack)) { issues.push(`ext 未注册 pack: ${pack}`); continue }
    for (const k of Object.keys(val)) if (!PACK_FIELDS[pack].includes(k)) issues.push(`ext.${pack} 未知字段: ${k}`)
  }

  const budget = budgetFor(card.source?.density ?? 0.5)
  const storage = estTokens(JSON.stringify(card))
  if (storage > budget.storage) issues.push(`存储态超预算: ${storage} > ${budget.storage}`)
  // 交叉检查：低密度章却"事件多且信息增量大" → density 可能打分偏低
  const d = card.source?.density ?? 0.5
  const evidence = (card.entities_new?.length ?? 0) + (card.state_changes?.length ?? 0)
    + (card.items?.length ?? 0) + (card.reveals?.length ?? 0) + (card.foreshadow?.planted?.length ?? 0)
  if (d < 0.6 && Array.isArray(card.beats) && card.beats.length > 4 && evidence >= 4) {
    issues.push(`density 可能偏低: ${d} 但 beats=${card.beats.length}、信息增量项=${evidence}（建议 ≥0.6）`)
  }
  if (!card.contentRedactions?.length) {
    // 无红act属正常；此处不判失败，仅记录
  }
  return issues
}

// ---------- 关系图：从 cards.relations 累积时序边 ----------
export function deriveGraph(cards) {
  const nodes = new Map()
  const edges = []
  const touch = (name, ch) => {
    if (!name) return
    if (!nodes.has(name)) nodes.set(name, { name, firstChapter: ch, chapters: new Set(), kinds: new Set() })
    const n = nodes.get(name)
    n.chapters.add(ch)
  }

  for (const c of [...cards].sort((x, y) => x.chapter - y.chapter)) {
    for (const e of c.entities_new || []) {
      touch(e.name, c.chapter)
      nodes.get(e.name)?.kinds.add(e.kind)
    }
    for (const r of c.relations || []) {
      touch(r.a, c.chapter); touch(r.b, c.chapter)
      // 同一条有向边若已开放，且 rel 相同 → 延展；rel 变化 → 关闭旧的、开新的
      const open = edges.find((x) => x.a === r.a && x.b === r.b && x.toChapter === null)
      if (open) {
        if (open.rel === r.rel) { open.toChapter = null; continue }
        open.toChapter = Math.max(open.fromChapter, (r.since ?? c.chapter) - 1)
      }
      edges.push({ a: r.a, rel: r.rel, b: r.b, fromChapter: r.since ?? c.chapter, toChapter: null })
    }
  }
  return {
    nodes: [...nodes.values()].map((n) => ({
      name: n.name,
      kind: [...n.kinds][0] || 'person',
      firstChapter: n.firstChapter,
      chapterCount: n.chapters.size,
    })).sort((a, b) => a.firstChapter - b.firstChapter),
    edges,
  }
}

// ---------- Bible：从 cards + graph 投影 ----------
export function buildBible(cards, graph, { maxChars = 1800 } = {}) {
  // 伏笔：planted 分配稳定 id，paid 解析回 id（支持字符串与 {id} 两种写法）
  const planted = []
  for (const c of cards) {
    (c.foreshadow?.planted || []).forEach((p, i) => {
      const desc = typeof p === 'string' ? p : (p.desc ?? '')
      const id = (typeof p === 'object' && p.id) ? p.id : 'F-' + c.chapter + '-' + (i + 1)
      planted.push({ id: id, chapter: c.chapter, desc: desc })
    })
  }
  const paidLabels = []
  for (const c of cards) {
    for (const p of c.foreshadow?.paid || []) {
      paidLabels.push(typeof p === 'string' ? p : (p.id ?? p.desc ?? ''))
    }
  }
  const paidIds = new Set()
  const unresolvedPaid = []
  for (const label of paidLabels) {
    if (planted.some((t) => t.id === label)) { paidIds.add(label); continue }
    const inc = planted.find((t) => label.length >= 3 && (t.desc.includes(label) || label.includes(t.desc)))
    if (inc) { paidIds.add(inc.id); continue }
    let best = null
    let bestScore = 0
    for (const t of planted) {
      const s = overlapRatio(label, t.desc)
      if (s > bestScore) { bestScore = s; best = t }
    }
    if (best && bestScore >= 0.25) paidIds.add(best.id)
    else unresolvedPaid.push(label)
  }
  const openThreads = planted.map((t) => ({
    id: t.id, chapter: t.chapter, desc: t.desc,
    status: paidIds.has(t.id) ? 'paid' : 'open',
  }))

  const timeline = cards.map((c) => ({
    chapter: c.chapter,
    story: c.time?.story ?? '',
    span: c.time?.span ?? '',
    location: (c.location || []).join('、'),
    density: c.source?.density ?? 0.5,
    // 只取第一条 beat 信息量太低，取前两条并保持时间顺序
    event: (c.beats || []).slice(0, 2).join('；'),
  }))

  const characters = graph.nodes
    .map((n) => {
      const rels = graph.edges.filter((e) => e.a === n.name || e.b === n.name)
      return {
        name: n.name,
        kind: n.kind,
        firstChapter: n.firstChapter,
        chapterCount: n.chapterCount,
        relations: rels.map((e) => (e.a === n.name ? `${e.rel}→${e.b}` : `${e.a}→${e.rel}→me`)),
      }
    })
    .slice(0, maxChars > 0 ? 60 : 0)

  return {
    schema: 1,
    builtAt: new Date().toISOString(),
    chapterRange: [cards[0]?.chapter ?? 0, cards[cards.length - 1]?.chapter ?? 0],
    coverage: { cards: cards.length },
    characters,
    timeline,
    openThreads,
    volumes: [],
    stats: {
      characters: characters.length,
      edges: graph.edges.length,
      openThreads: openThreads.filter((t) => t.status === 'open').length,
      paidThreads: openThreads.filter((t) => t.status === 'paid').length,
      unresolvedPaid: unresolvedPaid.length,
    },
  }
}

// ---------- 渲染：卡片 → 注入态（含裁剪） ----------
const REL_ZH = { kin: '亲属', friend: '友', ally: '同伙', hostile: '敌对', rival: '竞争', lover: '恋人', mentor: '师承', subordinate: '下属', acquaint: '相识' }

export function renderCard(card, { trim = true } = {}) {
  const c = JSON.parse(JSON.stringify(card))
  const budget = budgetFor(c.source?.density ?? 0.5)
  let trimmed = []

  const build = () => {
    const L = []
    const mode = c.time?.mode === 'linear' ? '' : (c.time?.mode === 'flashback' ? '·闪回' : c.time?.mode === 'timeskip' ? '·跳跃' : '')
    L.push(`【第${c.chapter}章】${c.time?.span ?? ''}${mode}${c.pov ? '｜视角:' + c.pov.join('/') : ''}`)
    if (c.location?.length) L.push('地:' + c.location.join('、'))
    for (const b of c.beats || []) L.push('· ' + b)
    if (c.entities_new?.length) L.push('新:' + c.entities_new.map((e) => `${e.name}(${e.tag || e.kind})`).join('、'))
    if (c.relations?.length) L.push('关系:' + c.relations.map((r) => `${r.a}-${REL_ZH[r.rel] || r.rel}-${r.b}`).join('；'))
    if (c.state_changes?.length) L.push('变:' + c.state_changes.map((s) => `${s.subject}.${s.field}:${s.from}→${s.to}` + (s.cause ? `（因:${s.cause}）` : '')).join('；'))
    if (c.items?.length) L.push('物:' + c.items.map((i) => `${i.name}${i.change}${i.holder ? '(' + i.holder + ')' : ''}`).join('、'))
    if (c.reveals?.length) L.push('知:' + c.reveals.map((r) => `${r.who}得知${r.fact}`).join('；'))
    if (c.foreshadow?.planted?.length) L.push('伏:' + c.foreshadow.planted.join('；'))
    if (c.hook?.text) L.push('钩:' + c.hook.text)
    for (const [pack, val] of Object.entries(c.ext || {})) {
      const bits = Object.entries(val).map(([k, v]) => `${k}=${[].concat(v).join('/')}`)
      L.push(`[${pack}] ` + bits.join('；'))
    }
    return L.join('\n')
  }

  let text = build()
  if (trim) {
    const steps = [
      () => { for (const k of Object.keys(c.ext || {})) { delete c.ext[k]; trimmed.push('ext:' + k) } },
      () => { if (c.reveals) { delete c.reveals; trimmed.push('reveals') } },
      () => { if (c.relations?.length > 2) { c.relations = c.relations.slice(0, 2); trimmed.push('relations>2') } },
      () => { if (c.beats?.length > 4) { c.beats = c.beats.slice(0, 4); trimmed.push('beats>4') } },
      // 高密度章光靠上面四步可能仍差十几 token（ch84 实测 314 > 300），继续让步
      () => { if (c.items) { delete c.items; trimmed.push('items') } },
      () => { if (c.entities_new?.length > 3) { c.entities_new = c.entities_new.slice(0, 3); trimmed.push('entities>3') } },
      () => { if (c.state_changes?.length > 3) { c.state_changes = c.state_changes.slice(0, 3); trimmed.push('states>3') } },
      () => { if (c.beats?.length > 3) { c.beats = c.beats.slice(0, 3); trimmed.push('beats>3') } },
      () => { if (c.foreshadow?.planted?.length > 1) { c.foreshadow.planted = c.foreshadow.planted.slice(0, 1); trimmed.push('planted>1') } },
      () => { if (c.state_changes?.length > 2) { c.state_changes = c.state_changes.slice(0, 2); trimmed.push('states>2') } },
    ]
    for (const step of steps) {
      if (estTokens(text) <= budget.inject) break
      step(); text = build()
    }
  }
  const tokens = estTokens(text)
  return { text: (trimmed.length ? '[已裁剪]\n' : '') + text, tokens, trimmed, overBudget: tokens > budget.inject, budget }
}

// ---------- 概要：从 bible + cards 投影 ----------
/**
 * 续写概要（投影型）。
 *
 * 全书规模下概要不设上限会爆（368 章实测 17,955 token，standard 档预算 6,000），
 * 所以这里做**按档位裁剪 + 预算收敛**：
 *   - D 段：章节多时只留"高密度章 + 最近 5 章"，并标出省略数
 *   - E 段：伏笔按章号倒序截断（账本会线性膨胀到几百条）
 *   - C 段：人物按出场章数排序截断
 *   - 最后按预算反复减半重排，直到收敛
 */
export function buildSynopsis(bible, cards, { tier = 'standard', upto = null } = {}) {
  const BUDGET = { compact: 2000, standard: 6000, full: 20000 }
  const budget = BUDGET[tier] ?? 6000

  const scoped = upto === null ? cards : cards.filter((c) => c.chapter <= upto)
  const timeline = bible.timeline.filter((t) => upto === null || t.chapter <= upto)
  const recent = scoped.slice(-3)

  const caps = {
    compact: { person: 8, thread: 8, chapter: 12 },
    standard: { person: 20, thread: 20, chapter: 40 },
    full: { person: 40, thread: 60, chapter: 200 },
  }[tier] ?? { person: 20, thread: 20, chapter: 40 }

  const render = (cap) => {
    const L = []
    L.push('# 《流氓高手》续写概要（投影型）')
    L.push('')
    L.push(`> 覆盖章节：${scoped[0]?.chapter ?? 0}–${scoped[scoped.length - 1]?.chapter ?? 0}｜档位：${tier}｜生成方式：投影（无新增事实）`)
    L.push('')

    // C 人物谱：按出场章数排序，截断
    const persons = bible.characters.filter((c) => c.kind === 'person')
      .sort((a, b) => b.chapterCount - a.chapterCount)
    const places = bible.characters.filter((c) => c.kind !== 'person')
    L.push('## C 人物谱')
    for (const ch of persons.slice(0, cap.person)) {
      const rel = ch.relations.length ? '｜' + ch.relations.join('，') : ''
      L.push(`- ${ch.name}（首现第 ${ch.firstChapter} 章）${rel}`)
    }
    if (persons.length > cap.person) L.push(`- （另有 ${persons.length - cap.person} 位人物省略）`)
    if (places.length) {
      L.push('')
      L.push('**地点与组织**：' + places.slice(0, 12).map((p) => `${p.name}（第 ${p.firstChapter} 章）`).join('、'))
    }
    L.push('')

    // D 剧情脉络：高密度章 + 最近 5 章
    L.push('## D 剧情脉络')
    let picked = timeline
    if (timeline.length > cap.chapter) {
      const keyChapters = new Set(
        [...timeline].sort((a, b) => b.density - a.density).slice(0, cap.chapter - 5).map((t) => t.chapter),
      )
      for (const t of timeline.slice(-5)) keyChapters.add(t.chapter)
      picked = timeline.filter((t) => keyChapters.has(t.chapter))
    }
    for (const t of picked) {
      L.push(`- 第 ${t.chapter} 章｜${t.story}${t.span ? '·' + t.span : ''}｜${t.location}｜${t.event}`)
    }
    if (timeline.length > picked.length) L.push(`- （另有 ${timeline.length - picked.length} 章省略）`)
    L.push('')

    // E 伏笔账本：按章号倒序（最近的更可能相关）
    L.push('## E 伏笔账本')
    const open = bible.openThreads.filter((t) => t.status === 'open').sort((a, b) => b.chapter - a.chapter)
    const paid = bible.openThreads.filter((t) => t.status !== 'open')
    L.push(`未回收 ${bible.openThreads.filter((t) => t.status === 'open').length} 条（列出最近 ${Math.min(cap.thread, open.length)} 条）：`)
    for (const t of open.slice(0, cap.thread)) L.push(`- 第 ${t.chapter} 章：${t.desc}`)
    if (open.length > cap.thread) L.push(`- （另有 ${open.length - cap.thread} 条较早的未回收伏笔省略）`)
    L.push(`已回收 ${paid.length} 条。`)
    // paid 被误用（写成本章因果描述而非引用既往伏笔）时，把"对不上的"显式暴露，而不是静默丢弃
    const unresolved = bible.stats?.unresolvedPaid ?? 0
    if (unresolved > 0) L.push(`另有 ${unresolved} 条回收标注无法对应到具体伏笔，未计入已回收。`)
    L.push('')

    L.push('## F 续写接入点')
    const last = recent[recent.length - 1]
    if (last) {
      L.push(`- 上一章：第 ${last.chapter} 章（${last.time?.span ?? ''}，${(last.location || []).join('、')}）`)
      L.push(`- 章末状态：${last.hook?.text ?? '（未记录）'}`)
      L.push('- 推进方向（建议）：')
      for (const b of (last.beats || []).slice(-2)) L.push(`  · 承接「${b}」`)
    }
    L.push('')
    return L.join('\n')
  }

  let cap = { ...caps }
  let md = render(cap)
  for (let i = 0; i < 6 && estTokens(md) > budget; i++) {
    cap = {
      person: Math.max(5, Math.floor(cap.person / 2)),
      thread: Math.max(4, Math.floor(cap.thread / 2)),
      chapter: Math.max(8, Math.floor(cap.chapter / 2)),
    }
    md = render(cap)
  }
  return md
}

/**
 * 长章切段：超过 maxChars 的章按段落边界切成多段，供分段抽取。
 *
 * 动机：ch84（6,194 字）在单次调用里连续失败两次——输出预算被 reasoning 吃掉，
 * 返回空文本。分段后每段输出规模可控，失败率显著下降。
 *
 * @returns 段落数组；不需要切分时返回单元素数组。
 */
export function splitForExtraction(body, maxChars = 4000) {
  const text = String(body)
  if (text.length <= maxChars) return [{ index: 1, total: 1, text }]
  const paragraphs = text.split('\n')
  const parts = []
  let buf = []
  let size = 0
  for (const p of paragraphs) {
    if (size + p.length > maxChars && buf.length) {
      parts.push(buf.join('\n'))
      buf = []
      size = 0
    }
    buf.push(p)
    size += p.length + 1
  }
  if (buf.length) parts.push(buf.join('\n'))
  return parts.map((t, i) => ({ index: i + 1, total: parts.length, text: t }))
}

/**
 * 合并分段抽取结果：beats 按序拼接并截到 6 条，其余字段去重合并。
 * 后段覆盖前段的标量字段（time/pov/location 取并集，hook 取最后一段）。
 */
export function mergePartCards(parts, base) {
  const first = parts[0] ?? {}
  const beats = []
  for (const p of parts) for (const b of p.beats ?? []) if (!beats.includes(b)) beats.push(b)
  const uniqBy = (arr, key) => {
    const seen = new Set()
    return arr.filter((x) => {
      const k = key(x)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  const entities = uniqBy(parts.flatMap((p) => p.entities_new ?? []), (e) => e.name)
  const relations = uniqBy(parts.flatMap((p) => p.relations ?? []), (r) => `${r.a}|${r.rel}|${r.b}`)
  const states = uniqBy(parts.flatMap((p) => p.state_changes ?? []), (s) => `${s.subject}|${s.field}|${s.to}`)
  const items = uniqBy(parts.flatMap((p) => p.items ?? []), (i) => `${i.name}|${i.change}`)
  const reveals = uniqBy(parts.flatMap((p) => p.reveals ?? []), (r) => `${r.who}|${r.fact}`)
  const planted = uniqBy(parts.flatMap((p) => p.foreshadow?.planted ?? []), (x) => String(x?.desc ?? x))
  const paid = uniqBy(parts.flatMap((p) => p.foreshadow?.paid ?? []), (x) => String(x?.id ?? x))
  const redactions = parts.flatMap((p) => p.contentRedactions ?? [])
  const last = parts[parts.length - 1] ?? {}

  const card = {
    // schema 必须来自分段结果：base 只带 chapter/title/source，
    // 缺了 schema 会被 validateCard 判「缺少必填字段」
    schema: first.schema ?? 2,
    ...base,
    time: {
      story: parts.map((p) => p.time?.story).filter(Boolean).join('；'),
      span: parts.map((p) => p.time?.span).filter(Boolean).join(' → '),
      mode: first.time?.mode ?? 'linear',
    },
    pov: [...new Set(parts.flatMap((p) => p.pov ?? []))],
    location: [...new Set(parts.flatMap((p) => p.location ?? []))],
    beats: beats.slice(0, 6),
    entities_new: entities,
    relations,
    state_changes: states,
    items,
    reveals,
    foreshadow: { planted, paid },
    hook: last.hook ?? first.hook ?? { text: '', type: 'quiet' },
    ext: Object.assign({}, ...parts.map((p) => p.ext ?? {})),
    contentRedactions: redactions,
  }
  card.source = { ...(base.source ?? {}), density: computeDensity(card) }
  return card
}

/**
 * 把卡片裁到存储态预算以内。
 *
 * 分段合并后条目会翻倍（两段各自抽到的关系/状态/伏笔叠加），实测 ch84 合并后
 * 1201 token 超过 950 上限。这里按"信息损失从小到大"的顺序逐级收紧，
 * 直到落回预算内；beats 是最后的保留底线（不低于 3 条）。
 */
export function enforceStorageBudget(card) {
  const budget = budgetFor(card.source?.density ?? 0.5)
  const fits = (c) => estTokens(JSON.stringify(c)) <= budget.storage
  if (fits(card)) return card

  const cap = (c, p) => ({
    ...c,
    beats: (c.beats ?? []).slice(0, p.beats),
    entities_new: (c.entities_new ?? []).slice(0, p.entities),
    relations: (c.relations ?? []).slice(0, p.relations),
    state_changes: (c.state_changes ?? []).slice(0, p.states),
    items: (c.items ?? []).slice(0, p.items),
    reveals: (c.reveals ?? []).slice(0, p.reveals),
    foreshadow: {
      planted: (c.foreshadow?.planted ?? []).slice(0, p.planted),
      paid: c.foreshadow?.paid ?? [],
    },
  })

  // 逐级收紧；每一级都重新算，直到落回预算
  for (let beats = 6; beats >= 2; beats--) {
    const p = {
      beats,
      entities: Math.min(4, beats),
      relations: Math.min(3, beats - 1),
      states: Math.min(4, beats),
      items: Math.min(3, beats - 1),
      reveals: Math.min(2, beats - 2),
      planted: Math.min(3, beats),
    }
    const trimmed = cap(card, p)
    if (fits(trimmed)) return trimmed
  }

  // 兜底：只留 beats 与钩子，保证一定收敛
  for (let beats = 2; beats >= 1; beats--) {
    const minimal = {
      ...card,
      beats: (card.beats ?? []).slice(0, beats),
      entities_new: [],
      relations: [],
      state_changes: [],
      items: [],
      reveals: [],
      foreshadow: { planted: [], paid: [] },
      ext: {},
    }
    if (fits(minimal)) return minimal
  }
  return { ...card, beats: (card.beats ?? []).slice(0, 1), entities_new: [], relations: [], state_changes: [], items: [], reveals: [], foreshadow: { planted: [], paid: [] }, ext: {} }
}

// ---------- 剧本：单元剧本包（G 段，投影型） ----------
// 只做「单个事件/故事单元」，不提供全书→剧本。
//
// 地点与人物都是**投影**，不做位置猜测：
//   - 地点：拿 beat 文本去匹配本章 location 条目，唯一命中才采用；
//     多命中标「/」、零命中且本章只有一个地点才用它，否则一律「（待确认）」。
//   - 人物：只取 kind=person 的新实体与关系端点，并剔除全书已知的非人物实体。
export function buildScreenplay(bible, cards, { unitLabel = '', scenesByChapter = {} } = {}) {
  const nonPerson = new Set()
  for (const c of cards) {
    for (const e of c.entities_new || []) if (e.kind !== 'person') nonPerson.add(e.name)
  }

  const scenes = []
  let n = 0
  for (const c of cards) {
    // 优先用富化场次（模型读原文拆出来的），没有才退回卡片投影
    const enriched = scenesByChapter[c.chapter]
    if (Array.isArray(enriched) && enriched.length) {
      for (const s of enriched) {
        n += 1
        scenes.push({
          scene: n,
          chapter: c.chapter,
          place: s.place || '（未记录）',
          time: (s.mode && s.mode !== 'linear' ? (s.mode === 'flashback' ? '[闪回] ' : '[跳跃] ') : '') + (s.time || [c.time?.span, c.time?.story].filter(Boolean).join('·') || '（未记录）'),
          mode: s.mode || 'linear',
          people: (s.people ?? []).filter((p) => !nonPerson.has(p)).slice(0, 6),
          action: s.action || s.conflict || '',
          conflict: s.conflict || '',
          result: s.result || '',
          kind: s.kind || 'develop',
          source: 'enriched',
        })
      }
      continue
    }
    const locs = c.location || []
    const people = [...new Set([
      ...(c.entities_new || []).filter((e) => e.kind === 'person').map((e) => e.name),
      ...(c.relations || []).flatMap((r) => [r.a, r.b]),
    ])].filter((name) => name && !nonPerson.has(name)).slice(0, 6)

    const beats = c.beats || []
    beats.forEach((b, i) => {
      const hits = locs.filter((l) => b.includes(l))
      let place
      if (hits.length === 1) place = hits[0]
      else if (hits.length > 1) place = hits.join('/') + '?'
      else if (locs.length === 1) place = locs[0]
      else place = '（待确认）'

      n += 1
      scenes.push({
        scene: n,
        chapter: c.chapter,
        place,
        time: [c.time?.span, c.time?.story].filter(Boolean).join('·') || '（未记录）',
        people,
        action: b,
        conflict: '',
        result: '',
        kind: i === 0 ? 'setup' : i === beats.length - 1 ? 'turn' : 'develop',
        source: 'projection',
      })
    })
  }

  const L = []
  L.push(`# 单元剧本包${unitLabel ? '：' + unitLabel : ''}`)
  L.push('')
  L.push(`> 覆盖第 ${cards[0]?.chapter ?? 0}–${cards[cards.length - 1]?.chapter ?? 0} 章｜共 ${cards.length} 张卡片｜${scenes.length} 场`)
  L.push('> 生成方式：**投影型**（只用已抽取的卡片，未阅读原文，未做推断）')
  L.push('')
  L.push('## 一、单元摘要')
  L.push(bible.timeline.map((t) => `- 第 ${t.chapter} 章｜${t.story}${t.span ? '·' + t.span : ''}｜${t.location}｜${t.event}`).join('\n'))
  L.push('')
  L.push('## 二、人物表（本单元涉及）')
  const persons = bible.characters.filter((c) => c.kind === 'person')
  L.push(persons.length ? persons.map((p) => `- ${p.name}（第 ${p.firstChapter} 章首现）`).join('\n') : '- （无）')
  L.push('')
  L.push('## 三、场次表')
  L.push('')
  L.push('| 场 | 章 | 地点 | 时间 | 人物 | 冲突 | 结果 | 功能 | 来源 |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  const kindZh = { setup: '建置', develop: '推进', turn: '转折' }
  const srcZh = { enriched: '原文', projection: '卡片' }
  for (const s of scenes) {
    L.push(`| ${s.scene} | ${s.chapter} | ${s.place} | ${s.time} | ${s.people.join('、') || '（未记录）'} | ${s.conflict || s.action} | ${s.result || '—'} | ${kindZh[s.kind]} | ${srcZh[s.source]} |`)
  }
  L.push('')
  L.push('## 四、改编取舍（需人工确认）')
  L.push('- 卡片只记录事件与状态，**没有对白原文**；场次表能定结构与节奏，细化对白必须回读本章原文。')
  L.push('- 心理描写与旁白在卡片里被压成事件描述，改编时要转成动作或台词。')
  L.push('- 同一地点连续多场可合并，但合并必须核对时间跨度（`time.span`）。')
  L.push('')
  L.push('## 五、未包含（P1 范围外）')
  L.push('- 不生成完整剧本全文（60 场约 6–9 万字，超出单次输出能力，需分幕批次生成）。')
  L.push('- 不做集/幕规划与全书结构——工具只对**单个叙事单元**负责。')
  L.push('')
  return { md: L.join('\n'), scenes: scenes.length }
}

// ---------- 汇总校验 ----------
export function runValidation({ manifest, cards, graph, bible, synopsisMd }) {
  const cardIssues = []
  for (const c of cards) {
    const iss = validateCard(c)
    if (iss.length) cardIssues.push({ chapter: c.chapter, issues: iss })
  }

  // 图的悬空引用与枚举
  const names = new Set(graph.nodes.map((n) => n.name))
  const dangling = graph.edges.filter((e) => !names.has(e.a) || !names.has(e.b))
  const badEdges = graph.edges.filter((e) => !ENUMS.rel.includes(e.rel))

  // 渲染
  const renders = cards.map((c) => ({ chapter: c.chapter, ...renderCard(c) }))
  const overInject = renders.filter((r) => r.overBudget)

  return {
    cards: cards.length,
    cardIssues,
    graph: { nodes: graph.nodes.length, edges: graph.edges.length, dangling: dangling.length, badEdges: badEdges.length },
    bible: bible.stats,
    renders: renders.map((r) => ({ chapter: r.chapter, tokens: r.tokens, budget: r.budget.inject, trimmed: r.trimmed, over: r.overBudget })),
    overInject,
    synopsisTokens: estTokens(synopsisMd),
    manifestBreaks: manifest.numberingBreaks?.length ?? 0,
    manifestStatus: manifest.numberingStatus,
  }
}
