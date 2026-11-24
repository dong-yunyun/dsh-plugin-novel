// 验证用 mock：只复刻插件真正用到的那部分 DSH host 契约
//
// 目的不是"跑通一个假 DSH"，而是让 verify.mjs 能在不启动 DSH、不调真模型的前提下，
// 把插件的注册面、工具执行路径、注入钩子全部走一遍。凡是在生产会抛的错，
// 这里都要先抛一次。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 把一段文本切成两片喂进去，确保调用方是"累加 chunk"而不是"只取第一片"。 */
function fakeStream(text) {
  const cut = Math.ceil(text.length / 2)
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: text.slice(0, cut) }
      yield { type: 'text-delta', text: text.slice(cut) }
    },
  }
}

// ---- 假模型输出：按 system 提示词区分任务 ----
export function fakeCardJson(chapter = 1, title = '验证第一章') {
  return JSON.stringify({
    density: 0.45,
    time: { story: '一日', span: '一天', mode: 'linear' },
    pov: ['测试人物'],
    location: ['验证场'],
    beats: ['测试人物登场', '测试冲突发生'],
    entities_new: [{ name: '测试人物', kind: 'person', tag: '主角' }],
    relations: [{ a: '测试人物', rel: 'friend', b: '测试配角', since: chapter }],
    state_changes: [],
    items: [],
    reveals: [{ who: '测试人物', fact: '验证事实' }],
    foreshadow: { planted: [], paid: [] },
    hook: { text: '验证钩子', type: 'quiet' },
    ext: {},
    contentRedactions: [],
  })
}

export function fakeScenesJson() {
  return JSON.stringify([
    { place: '验证场', time: '上午', mode: 'linear', people: ['测试人物'], conflict: '验证冲突', result: '验证结果', kind: 'setup' },
    { place: '验证场', time: '傍晚', mode: 'linear', people: ['测试人物'], conflict: '验证冲突二', result: '验证结果二', kind: 'turn' },
  ])
}

export function fakeBriefJson() {
  return JSON.stringify({
    status: 'ok',
    brief: {
      承接: '从第 1 章结尾的状态接下去',
      目标: '验证续写简报链路',
      必须维持: ['测试人物在场'],
      禁止: ['让测试人物退场'],
      需澄清: [],
      建议篇幅: '约 800 字',
    },
  })
}

function defaultLlm(opts) {
  const sys = String(opts?.system ?? '')
  if (sys.includes('续写策划')) return fakeStream(fakeBriefJson())
  if (sys.includes('场次拆解器')) return fakeStream(fakeScenesJson())
  if (sys.includes('结构化抽取器')) return fakeStream(fakeCardJson())
  throw new Error(`mock llm 不认识这个 system 提示词：${sys.slice(0, 40)}`)
}

/**
 * 复刻 cordis 的 ctx 行为面：
 *   ctx.effect(fn) 立即执行 fn（DSH 里也要求 apply 阶段同步完成注册）
 *   ctx.tools.register(def) 同名二次注册视为错误
 *   ctx.on(event, fn) 收集钩子
 *   ctx.llm.stream(opts) 返回可 for-await 的流
 */
export function createMockContext({ llm = defaultLlm } = {}) {
  const tools = new Map()
  const handlers = new Map()
  const logs = []
  const llmCalls = []

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register(def) {
        if (!def || typeof def !== 'object') throw new Error('tools.register 收到非对象')
        if (tools.has(def.name)) throw new Error(`工具重复注册：${def.name}`)
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    llm: {
      stream(opts) {
        llmCalls.push(opts)
        return llm(opts)
      },
    },
  }

  return { ctx, tools, handlers, logs, llmCalls }
}

/** 构造一个"能拿到模型路由"的 exec，供需要继承路由的工具使用。 */
export function makeExec({ cwd = 'D:/codetest', origin = 'main', sessionId = 'verify-session' } = {}) {
  const injected = []
  const agent = {
    session: {
      id: sessionId,
      header: { cwd, origin },
      requestHeader: () => ({ config: { provider: 'mock-provider', model: 'mock-model' } }),
    },
    options: {},
    inject: (msg) => injected.push(msg),
  }
  return { exec: { agent }, agent, injected }
}

/** 临时小说数据集：够跑通 ingest / scenes / continue / synopsis 四条写路径。 */
export function makeTempNovel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-verify-'))
  fs.mkdirSync(path.join(root, 'chapters'), { recursive: true })
  fs.mkdirSync(path.join(root, 'cards'), { recursive: true })

  const manifest = {
    work: '验证样例',
    numberingStatus: 'regular',
    numberingBreaks: [],
    chapters: [
      { chapter: 1, title: '验证第一章', declared: 1, file: 'chapters/ch0001.md', chars: 96, startLine: 1, endLine: 8 },
    ],
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(
    path.join(root, 'chapters', 'ch0001.md'),
    '测试人物走进验证场。他看见测试配角站在门口，两人对视了一眼。\n\n"你来晚了。"测试配角说。\n\n测试人物没有回答。\n',
  )
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

// ---- profile 配置读取：生产到底用什么配置，验证就测什么配置 ----

const UNQUOTE = (s) => {
  const t = s.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1)
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (/^-?\d+$/.test(t)) return Number(t)
  return t
}

/**
 * 从 profile 的 cordis.patch.yml 里抠出 `- id: novel-helper` 那一块的 config。
 * 只支持插件配置用到的标量子集（没有嵌套、没有数组），够用且不引依赖。
 */
export function readPluginConfig(profilePatchPath, pluginId = 'novel-helper') {
  const raw = fs.readFileSync(profilePatchPath, 'utf8')
  const lines = raw.split(/\r?\n/)

  const start = lines.findIndex((l) => new RegExp(`^-\\s*id:\\s*${pluginId}\\s*$`).test(l))
  if (start < 0) throw new Error(`${profilePatchPath} 里找不到 - id: ${pluginId}`)

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i]) || /^\S/.test(lines[i])) { end = i; break }
  }

  const block = lines.slice(start + 1, end)
  const cfgIdx = block.findIndex((l) => /^\s*config:\s*$/.test(l))
  if (cfgIdx < 0) throw new Error(`${profilePatchPath} 的 ${pluginId} 没有 config 段`)

  const config = {}
  for (let i = cfgIdx + 1; i < block.length; i++) {
    const line = block[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const m = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) break
    const [, key, value] = m
    config[key] = value === '' ? '' : UNQUOTE(value)
  }
  if (!Object.keys(config).length) throw new Error(`${profilePatchPath} 的 ${pluginId}.config 解析为空`)
  return config
}
