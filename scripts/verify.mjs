#!/usr/bin/env node
// 生产准入验证（pre-production gate）
//
// 定位：任何将要被 DSH 加载的代码，必须先过这里。验证不通过 → 不允许写入生产。
//
// 为什么不能只做 `node --check`：
//   上次挂掉的直接原因不是语法错，而是 index.js 里少了一个 import，
//   语法检查一路绿灯，直到 apply() 真的跑起来才抛 ReferenceError。
//   所以这里的验证必须把插件「真的跑一遍」：注册工具、调工具、触发钩子。
//
// 用法：
//   node scripts/verify.mjs                  # 验当前开发目录
//   node scripts/verify.mjs --pkg prod       # 验生产实际指向的目录
//   node scripts/verify.mjs --pkg <dir>      # 验指定目录（发布件）
//   node scripts/verify.mjs --json           # 机器可读输出
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createMockContext, makeExec, makeTempNovel, readPluginConfig,
} from './lib/mock-dsh.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEV_DIR = path.resolve(HERE, '..')
export const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
export const PROD_LINK = path.join(PROFILE_DIR, 'node_modules', 'dsh-novel-helper')
export const PROFILE_PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml')

const EXPECTED_TOOLS = [
  'novel_import', 'novel_ingest', 'novel_status', 'novel_context',
  'novel_continue', 'novel_scenes', 'novel_synopsis',
]

const toPosix = (p) => p.split(path.sep).join('/')
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// ---------- 文件工具 ----------

/** 极简 glob：只支持本仓库 package.json 里用到的 `*`、`**`、`?`。 */
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') i++
        re += '(?:.*/)?'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'releases'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else out.push(toPosix(path.relative(base, full)))
  }
  return out
}

/** package.json 里 "files" 声明了什么，就只验什么——生产只会拿到这些文件。 */
export function listShippedFiles(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const patterns = (pkg.files ?? []).map(globToRegExp)
  const all = walk(pkgDir)
  const shipped = all.filter((rel) => patterns.some((re) => re.test(rel)))
  return { pkg, all, shipped: [...new Set(shipped)].sort() }
}

// ---------- 单项检查 ----------
// 每个检查成功返回一句人话，失败直接 throw。runVerify 负责捕获与汇总。

function checkManifest(S) {
  const { pkg, shipped, all } = listShippedFiles(S.pkgDir)
  S.pkg = pkg
  S.shipped = shipped
  S.all = all

  if (pkg.name !== 'dsh-novel-helper') throw new Error(`package.json name 不对：${pkg.name}`)
  if (pkg.type !== 'module') throw new Error('package.json 必须声明 "type": "module"')

  for (const key of ['index.js', 'cordis.patch.yml']) {
    if (!shipped.includes(key)) throw new Error(`"files" 里没有 ${key}，生产会缺文件`)
  }
  if (pkg.exports?.['.'] !== './index.js') throw new Error('exports["."] 必须指向 ./index.js')
  const patchPath = pkg.dsh?.bundle?.patch
  if (!patchPath) throw new Error('package.json 缺少 dsh.bundle.patch')
  if (!fs.existsSync(path.join(S.pkgDir, patchPath))) throw new Error(`dsh.bundle.patch 指向的文件不存在：${patchPath}`)

  // "files" 里写了但磁盘上没有 → 发布件必然缺件
  for (const rel of shipped) {
    if (!fs.existsSync(path.join(S.pkgDir, rel))) throw new Error(`"files" 声明了不存在的文件：${rel}`)
  }

  // 发布件完整性：publish 会写 release.json，之后任何人手改都会被这里抓住
  const releaseFile = path.join(S.pkgDir, 'release.json')
  if (fs.existsSync(releaseFile)) {
    const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'))
    const bad = []
    for (const [rel, hash] of Object.entries(release.files ?? {})) {
      const full = path.join(S.pkgDir, rel)
      if (!fs.existsSync(full)) { bad.push(`${rel}(缺失)`); continue }
      if (sha256(full) !== hash) bad.push(`${rel}(被改动)`)
    }
    if (bad.length) throw new Error(`发布件与签署记录不一致：${bad.join('、')}`)
    S.release = release
    return `发布件 ${release.id} 完整，${shipped.length} 个文件`
  }
  return `${shipped.length} 个发布文件齐全（开发目录，无签署记录）`
}

async function checkModules(S) {
  const mods = S.shipped.filter((f) => /\.(mjs|js)$/.test(f))
  if (!mods.length) throw new Error('"files" 里没有任何 JS 模块')

  for (const rel of mods) {
    try {
      await import(pathToFileURL(path.join(S.pkgDir, rel)).href)
    } catch (err) {
      throw new Error(`${rel} 无法导入：${err?.message ?? err}`)
    }
  }

  // 依赖可移植性：生产发布的包没有 node_modules，裸包名一定加载失败。
  // 只认模块顶格的 import/export 语句与动态 import()，避免误伤提示词里的引号内容。
  const SPEC_RES = [
    /^[ \t]*(?:import|export)\s[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  const bad = []
  for (const rel of mods) {
    const src = fs.readFileSync(path.join(S.pkgDir, rel), 'utf8')
    const specs = SPEC_RES.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]))
    for (const spec of specs) {
      const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')
      if (!ok) bad.push(`${rel} → ${spec}`)
      if (/^[A-Za-z]:[\\/]/.test(spec)) bad.push(`${rel} → 绝对路径 ${spec}`)
    }
  }
  if (bad.length) throw new Error(`不可移植的依赖：${bad.join('、')}`)
  return `${mods.length} 个模块可导入，依赖全部为 node: 内置或相对路径`
}

async function checkEntryContract(S) {
  S.plugin = await import(pathToFileURL(path.join(S.pkgDir, 'index.js')).href)
  const { apply, inject } = S.plugin
  if (typeof apply !== 'function') throw new Error('index.js 没有导出 apply 函数')
  if (!Array.isArray(inject)) throw new Error('index.js 的 inject 必须是数组')
  if (!inject.every((x) => typeof x === 'string')) throw new Error('inject 数组元素必须是字符串')
  return `apply + inject=[${inject.join(', ')}]`
}

async function checkActivation(S) {
  // 1) 无 novelDir 时必须安静待命，不能抛
  const idle = createMockContext()
  S.plugin.apply(idle.ctx, {})
  if (idle.tools.size !== 0) throw new Error('novelDir 未配置时不应注册任何工具')

  // 2) 用生产真实配置激活
  const mock = createMockContext()
  S.plugin.apply(mock.ctx, S.config)
  S.tools = mock.tools
  S.handlers = mock.handlers
  S.logs = mock.logs

  const missing = EXPECTED_TOOLS.filter((n) => !mock.tools.has(n))
  const extra = [...mock.tools.keys()].filter((n) => !EXPECTED_TOOLS.includes(n))
  if (missing.length) throw new Error(`缺少工具：${missing.join(', ')}`)
  if (extra.length) throw new Error(`多出未登记的工具：${extra.join(', ')}`)
  return `按生产配置注册 ${mock.tools.size} 个工具`
}

async function checkReadOnlyTools(S) {
  const { agent } = makeExec()
  const exec = { agent }

  const status = await S.tools.get('novel_status').execute({}, exec)
  if (!status || typeof status !== 'object') throw new Error('novel_status 没有返回对象')
  if (!(status.chapters > 0)) throw new Error('novel_status.chapters 为 0，生产数据不可读')
  if (!(status.extracted > 0)) throw new Error('novel_status.extracted 为 0，生产数据不可读')
  if (!Array.isArray(status.renders) || status.renders.length !== status.extracted) {
    throw new Error('novel_status.renders 数量与 extracted 不一致')
  }

  const first = status.renders[0].chapter
  const last = status.renders[status.renders.length - 1].chapter
  const ctxOut = await S.tools.get('novel_context').execute({ from: first, to: last }, exec)
  if (!Array.isArray(ctxOut.blocks) || ctxOut.blocks.length === 0) throw new Error('novel_context 没有返回卡片文本')
  if (ctxOut.blocks.some((b) => typeof b !== 'string' || !b.trim())) throw new Error('novel_context 返回了空文本块')
  if (!(ctxOut.tokens > 0)) throw new Error('novel_context.tokens 必须为正数')

  S.samples = { novel_status: status, novel_context: ctxOut }
  return `status/context 读通：${status.extracted} 章、${ctxOut.tokens} token`
}

async function checkWritePaths(S) {
  const tmp = makeTempNovel()
  S.tmp = tmp
  const mock = createMockContext()
  S.plugin.apply(mock.ctx, { ...S.config, novelDir: tmp.root, autoInject: false })
  const { agent } = makeExec({ cwd: tmp.root })
  const exec = { agent }
  const T = mock.tools

  // 抽取：走完整 LLM → 解析 → 校验 → 落盘
  const ingest = await T.get('novel_ingest').execute({ from: 1, to: 1, limit: 1 }, exec)
  if (ingest.failed?.length) throw new Error(`novel_ingest 失败：${JSON.stringify(ingest.failed)}`)
  if (ingest.done?.length !== 1) throw new Error('novel_ingest 没有写入任何卡片')
  const cardFile = path.join(tmp.root, 'cards', 'ch0001.json')
  if (!fs.existsSync(cardFile)) throw new Error('novel_ingest 报告成功但卡片文件不存在')

  // 场次：同样需要模型，且写 scenes/
  const scenes = await T.get('novel_scenes').execute({ from: 1, to: 1, limit: 1 }, exec)
  if (scenes.failed?.length) throw new Error(`novel_scenes 失败：${JSON.stringify(scenes.failed)}`)
  if (!fs.existsSync(path.join(tmp.root, 'scenes', 'ch0001.json'))) throw new Error('novel_scenes 没有写入场次文件')

  // 续写：一致性闸门 + 简报解析
  const cont = await T.get('novel_continue').execute({ topic: '验证主题' }, exec)
  if (cont.status !== 'ok') throw new Error(`novel_continue 返回异常状态：${cont.status}`)
  if (!cont.brief || !cont.brief.承接) throw new Error('novel_continue 没有给出承接点')

  // 概要：写 synopses/
  const syn = await T.get('novel_synopsis').execute({ profile: 'continue', tier: 'standard' })
  if (!syn.path || !fs.existsSync(syn.path)) throw new Error('novel_synopsis 没有产出文件')
  if (!(syn.tokens > 0)) throw new Error('novel_synopsis.tokens 必须为正数')

  S.samples = {
    ...S.samples,
    novel_ingest: ingest, novel_scenes: scenes, novel_continue: cont, novel_synopsis: syn,
  }
  return 'ingest / scenes / continue / synopsis 四条写路径全通'
}

function checkToolConformance(S) {
  const problems = []
  for (const [name, def] of S.tools) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(name)) problems.push(`${name}: 工具名不合规`)
    if (typeof def.description !== 'string' || def.description.trim().length < 8) problems.push(`${name}: description 太短`)

    const params = def.parameters
    if (!params || typeof params !== 'object') problems.push(`${name}: 缺少 parameters`)
    else {
      if (params.type !== 'object') problems.push(`${name}: parameters.type 必须是 object`)
      const props = params.properties ?? {}
      for (const [k, v] of Object.entries(props)) {
        if (!v || typeof v.type !== 'string') problems.push(`${name}: parameters.properties.${k} 缺少 type`)
      }
      for (const r of params.required ?? []) {
        if (!(r in props)) problems.push(`${name}: required 里的 ${r} 没有在 properties 中定义`)
      }
    }

    if (!def.output || typeof def.output !== 'object') problems.push(`${name}: 缺少 output`)
    else if (typeof def.output.render !== 'function') problems.push(`${name}: output.render 不是函数`)

    if (typeof def.execute !== 'function') problems.push(`${name}: execute 不是函数`)

    // render 必须能为该工具的样例结果产出同构的 text block
    const sample = S.samples?.[name]
    if (sample !== undefined && typeof def.output?.render === 'function') {
      let blocks
      try {
        blocks = def.output.render({}, sample)
      } catch (err) {
        problems.push(`${name}: render 抛错 ${err?.message ?? err}`)
        continue
      }
      if (!Array.isArray(blocks) || blocks.length === 0) problems.push(`${name}: render 未返回非空数组`)
      else if (blocks.some((b) => b?.type !== 'text' || typeof b.text !== 'string' || !b.text.trim())) {
        problems.push(`${name}: render 返回的 block 不是 {type:"text", text:string}`)
      }
    }
  }
  if (problems.length) throw new Error(problems.join('；'))
  return `${S.tools.size} 个工具 schema 与 render 全部合规`
}

async function checkPreStepHook(S) {
  const list = S.handlers.get('agent/pre-step') ?? []
  if (!list.length) {
    if (S.config.autoInject) throw new Error('配置开了 autoInject，但没有注册 agent/pre-step 钩子')
    return '未启用注入（autoInject=false）'
  }
  if (list.length > 1) throw new Error(`agent/pre-step 注册了 ${list.length} 个钩子，会重复注入`)

  const hook = list[0]
  // 注入要同时满足 cwd 命中与"本轮在聊这本书"，所以 fixture 必须带上用户消息
  const userMsg = (text) => [{ role: 'user', content: [{ type: 'text', text }] }]
  const { agent, injected } = makeExec({ cwd: 'D:/codetest', origin: 'main', sessionId: 'verify-main' })
  await hook({ agent, messages: userMsg(`接着写《${S.workName}》第 85 章吧`) }, async () => {})

  if (injected.length !== 1) {
    // 钩子内部是 try/catch 兜住的，异常只会变成一条 warn 日志。
    // 把插件自己的日志带出来，否则"注入 0 条"看不到真正的原因。
    const recent = (S.logs ?? [])
      .filter(([lvl]) => lvl === 'warn' || lvl === 'error')
      .slice(-3).map(([, m]) => String(m).trim())
    throw new Error(`首步应注入 1 条前情，实际 ${injected.length} 条${recent.length ? `；插件日志：${recent.join(' | ')}` : ''}`)
  }
  const msg = injected[0]
  if (typeof msg.id !== 'string' || msg.id.length < 8) throw new Error('注入消息缺少合法 id（randomUUID 之类）')
  if (msg.role !== 'user') throw new Error(`注入消息 role 应为 user，实际 ${msg.role}`)
  // DSH v4 的硬规则（dsh-session-format-v3-to-v4/source()）：
  // source 必须是对象、kind 必须是非空字符串、且不能是已退役的 'plugin' 包装。
  // 违反时的现场报错是 "format v4 message requires a producer-owned source kind"。
  const src = msg.source
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('注入消息缺少 source，DSH v4 会拒绝')
  if (typeof src.kind !== 'string' || !src.kind) throw new Error('注入消息的 source.kind 必须是非空字符串')
  if (src.kind === 'plugin') throw new Error('source.kind 不能是已退役的 "plugin"，要用 "plugin:<名字>"')
  const text = msg.content?.[0]?.text
  if (typeof text !== 'string' || !text.includes('【前情】')) throw new Error('注入内容不是前情块')
  if (!text.includes(S.workName ?? '当')) throw new Error('注入内容里没有作品名')

  // 同一会话再次进入首步 → 不能重复注入
  await hook({ agent, messages: userMsg(`再看《${S.workName}》下一章`) }, async () => {})
  if (injected.length !== 1) throw new Error('同一会话被重复注入')

  // cwd 不匹配的会话 → 一条都不注入
  const other = makeExec({ cwd: 'D:/somewhere-else', origin: 'main', sessionId: 'verify-other' })
  await hook({ agent: other.agent, messages: userMsg(`接着写《${S.workName}》第 85 章`) }, async () => {})
  if (other.injected.length !== 0) throw new Error('cwd 不匹配的会话被注入了前情')

  // cwd 命中但本轮没在聊这本书 → 也不能注入（否则每次技术对话都会被塞满梗概）
  const unrelated = makeExec({ cwd: 'D:/codetest', origin: 'main', sessionId: 'verify-unrelated' })
  await hook({ agent: unrelated.agent, messages: userMsg('帮我修一下这个 TS 编译错误') }, async () => {})
  if (unrelated.injected.length !== 0) throw new Error('无关会话被注入了前情（意图判断失效）')

  // 只出现"续写"这个词、没提书名/人物 → 也不能注入（实测误伤过：用户说"不会产生续写"）
  const keywordOnly = makeExec({ cwd: 'D:/codetest', origin: 'main', sessionId: 'verify-keyword-only' })
  await hook({ agent: keywordOnly.agent, messages: userMsg('重启后已经确认不会产生续写') }, async () => {})
  if (keywordOnly.injected.length !== 0) throw new Error('只命中"续写"关键词就注入前情（应要求书名或人物名）')

  // 钩子自身出错时必须吞掉并 next()，不能把整轮对话打挂
  const broken = { session: { id: 'verify-broken', header: null }, inject: () => { throw new Error('boom') } }
  let nextCalled = false
  await hook({ agent: broken }, async () => { nextCalled = true })
  if (!nextCalled) throw new Error('钩子抛错后没有调用 next()，会阻断对话')

  return `注入 1 条、去重生效、异常不阻断`
}

async function checkData(S) {
  // 用"被测包自己"的校验器，而不是开发目录里的那一份
  const wf = await import(pathToFileURL(path.join(S.pkgDir, 'src/core/workflow.mjs')).href)
  const validateCard = wf.validateCard

  const dir = S.config.novelDir
  if (!dir) throw new Error('生产配置里 novelDir 为空')
  if (!fs.existsSync(dir)) throw new Error(`novelDir 不存在：${dir}`)

  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('找不到 manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.chapters) || !manifest.chapters.length) throw new Error('manifest.chapters 为空')
  if (typeof manifest.work !== 'string' || !manifest.work.trim()) throw new Error('manifest.work 为空')
  S.workName = manifest.work

  // 1) 章节文件必须在，且内容与 manifest 记录的 sha256 一致（数据被改坏要当场发现）
  const missing = []
  const corrupt = []
  for (const c of manifest.chapters) {
    const f = path.join(dir, 'chapters', path.basename(c.file))
    if (!fs.existsSync(f)) { missing.push(c.file); continue }
    if (c.sha256 && sha256(f) !== c.sha256) corrupt.push(path.basename(c.file))
  }
  if (missing.length) throw new Error(`manifest 声明了 ${missing.length} 个不存在的章节文件，例如 ${missing[0]}`)
  if (corrupt.length) throw new Error(`${corrupt.length} 个章节文件与 manifest 记录的 sha256 不一致，例如 ${corrupt[0]}`)

  // 2) 卡片：必须能解析、必须过 schema 校验、章节号必须与文件名一致
  const cardsDir = path.join(dir, 'cards')
  const cardFiles = fs.existsSync(cardsDir)
    ? fs.readdirSync(cardsDir).filter((f) => /^ch\d+\.json$/.test(f)).sort()
    : []
  if (!cardFiles.length) throw new Error('cards/ 为空，工具将无内容可用')

  const problems = []
  const chaptersSeen = new Set()
  for (const f of cardFiles) {
    let card
    try { card = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8')) }
    catch (err) { problems.push(`${f} 无法解析：${err.message}`); continue }

    const declared = Number(f.replace(/\D/g, ''))
    if (card.chapter !== declared) problems.push(`${f} 的 chapter=${card.chapter} 与文件名不一致`)
    if (chaptersSeen.has(card.chapter)) problems.push(`${f} 章号重复：${card.chapter}`)
    chaptersSeen.add(card.chapter)

    const issues = validateCard(card)
    if (issues.length) problems.push(`${f} schema 违规：${issues.join('; ')}`)
  }
  if (problems.length) {
    throw new Error(`${problems.length} 处卡片问题，首条：${problems[0]}${problems.length > 1 ? `（另 ${problems.length - 1} 处）` : ''}`)
  }

  return `${manifest.chapters.length} 章哈希一致、${cardFiles.length} 张卡片全部过 schema（${manifest.work}）`
}

// ---------- 编排 ----------

export function resolvePkgDir(which = '.') {
  if (which === '.' || which === 'dev') return DEV_DIR
  if (which === 'prod') {
    const target = fs.existsSync(PROD_LINK) ? fs.realpathSync.native(PROD_LINK) : ''
    if (!target) throw new Error(`生产链接不存在：${PROD_LINK}`)
    return target
  }
  return path.resolve(which)
}

export function isProdPointingAtDev() {
  if (!fs.existsSync(PROD_LINK)) return false
  return fs.realpathSync.native(PROD_LINK) === fs.realpathSync.native(DEV_DIR)
}

export async function runVerify({ pkgDir, config, log = () => {} } = {}) {
  const dir = pkgDir ?? DEV_DIR
  const S = { pkgDir: dir, config: config ?? readPluginConfig(PROFILE_PATCH) }

  const checks = [
    ['pkg/manifest', '包清单与发布文件', () => checkManifest(S)],
    ['pkg/modules', '模块可导入 + 依赖可移植', () => checkModules(S)],
    ['entry/contract', '插件导出契约', () => checkEntryContract(S)],
    ['activation', '可激活并注册全部工具', () => checkActivation(S)],
    ['data/readable', '生产数据可读', () => checkData(S)],
    ['tools/read-only', '只读工具冒烟', () => checkReadOnlyTools(S)],
    ['tools/write-paths', '写入路径冒烟（临时数据）', () => checkWritePaths(S)],
    ['tools/conformance', '工具 schema 与 render 合规', () => checkToolConformance(S)],
    ['hook/pre-step', '前情注入钩子', () => checkPreStepHook(S)],
  ]

  const results = []
  try {
    for (const [id, title, fn] of checks) {
      const started = Date.now()
      try {
        const detail = await fn()
        results.push({ id, title, ok: true, detail, ms: Date.now() - started })
        log(`PASS ${id}  ${detail}`)
      } catch (err) {
        results.push({ id, title, ok: false, detail: String(err?.message ?? err), ms: Date.now() - started })
        log(`FAIL ${id}  ${String(err?.message ?? err)}`)
        break // 前面的检查没过，后面的结论不可信
      }
    }
  } finally {
    S.tmp?.cleanup?.()
  }

  const ok = results.length === checks.length && results.every((r) => r.ok)
  return { ok, pkgDir: dir, results, skipped: checks.slice(results.length).map(([id]) => id), config: S.config }
}

// ---------- CLI ----------
const argv = process.argv.slice(2)
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href

if (isMain) {
  const flag = (name) => argv.includes(`--${name}`)
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }

  const asJson = flag('json')
  let pkgArg = value('pkg', '.')
  const print = (line) => { if (!asJson) console.log(line) }

  try {
    // 生产才是准绳：要求验生产，但生产还挂在开发目录上，就是自欺欺人
    if (pkgArg === 'prod' && isProdPointingAtDev()) {
      console.error('✘ 生产联接仍指向开发目录，此时"验生产"等于验开发目录。先跑 publish --apply。')
      process.exit(1)
    }
    const pkgDir = resolvePkgDir(pkgArg)
    const config = value('config')
      ? JSON.parse(fs.readFileSync(value('config'), 'utf8'))
      : readPluginConfig(value('profile', PROFILE_PATCH))

    if (!asJson) {
      console.log(`== 生产准入验证 · ${pkgDir} ==`)
      console.log(`   novelDir=${config.novelDir}  autoInject=${config.autoInject ?? false}  provider=${config.provider || '(继承)'}`)
      console.log('')
    }

    const result = await runVerify({ pkgDir, config, log: print })
    if (asJson) console.log(JSON.stringify(result, null, 2))

    const failed = result.results.filter((r) => !r.ok)
    if (!asJson) {
      console.log('')
      if (result.ok) console.log(`结论：全部 ${result.results.length} 项通过 → 允许发布`)
      else console.log(`结论：${failed.length} 项失败，其余 ${result.skipped.length} 项未执行 → 阻断发布`)
    }
    process.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error(`验证无法开始：${err?.message ?? err}`)
    process.exit(2)
  }
}
