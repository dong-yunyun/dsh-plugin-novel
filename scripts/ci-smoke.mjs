// CI 冒烟：不依赖真实作品数据，用 fixtures 里的小样跑通"导入 → 切分 → 注册工具"。
//
// 为什么不直接跑 verify：verify 是生产准入闸门，要求真实作品目录与卡片数据，
// 公开仓库里没有（版权原因）。这里只用 fixtures 验证代码本身能跑。

import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const FIXTURE = join(PKG_DIR, 'fixtures', 'format-matrix', 'full.txt')

const failures = []
const ok = (name, detail = '') => console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
const fail = (name, why) => { console.log(`  FAIL  ${name}  ${why}`); failures.push(name) }

async function main() {
  if (!existsSync(FIXTURE)) {
    console.error(`缺少 fixtures：${FIXTURE}`)
    process.exit(1)
  }

  const mod = await import(pathToFileURL(join(PKG_DIR, 'index.js')).href)
  console.log('== 插件冒烟 ==')

  // 1. 导出契约
  if (typeof mod.apply === 'function') ok('导出 apply')
  else fail('导出 apply', '不是函数')
  if (Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('llm')) {
    ok('inject 声明', JSON.stringify(mod.inject))
  } else fail('inject 声明', JSON.stringify(mod.inject))

  // 2. 空配置必须待命（生产闸门的 activation 契约）
  const emptyTools = []
  mod.apply({
    effect: (f) => f(), tools: { register: (d) => emptyTools.push(d) },
    on: () => () => {}, logger: { info: () => {}, warn: () => {} },
  }, { novelDir: '' })
  if (emptyTools.length === 0) ok('空 novelDir 待命', '0 个工具')
  else fail('空 novelDir 待命', `注册了 ${emptyTools.length} 个`)

  // 3. 导入 fixtures → 切分 → 注册
  const tmp = mkdtempSync(join(tmpdir(), 'novel-helper-ci-'))
  try {
    const tools = []
    const ctx = {
      effect: (f) => f(),
      tools: { register: (d) => tools.push(d) },
      on: () => () => {},
      logger: { info: () => {}, warn: () => {} },
    }
    const novelDir = join(tmp, 'novels', 'fixture')
    // 先用一个空目录占位，apply 只检查目录存在
    const { mkdirSync } = await import('node:fs')
    mkdirSync(novelDir, { recursive: true })
    mod.apply(ctx, { novelDir, novelsRoot: join(tmp, 'novels') })

    const names = tools.map((t) => t.name)
    if (names.length === 7) ok('注册工具数', names.join(','))
    else fail('注册工具数', `实际 ${names.length}：${names.join(',')}`)

    const importer = tools.find((t) => t.name === 'novel_import')
    const proposal = await importer.execute({ path: FIXTURE }, {})
    if (proposal.mode === 'proposal') ok('导入默认只在提议模式', '确认前不写盘')
    else fail('导入默认只在提议模式', JSON.stringify(proposal).slice(0, 120))

    const applied = await importer.execute({ path: FIXTURE, confirm: true, name: 'fixture' }, {})
    const first = applied.imported?.[0]
    if (first?.status === 'imported' && first.chapters > 0) {
      ok('导入并切分', `${first.work} ${first.chapters} 章`)
    } else fail('导入并切分', JSON.stringify(applied).slice(0, 160))

    const cards = readdirSync(join(tmp, 'novels', 'fixture')).filter((f) => f.endsWith('.json'))
    if (cards.includes('manifest.json')) ok('生成 manifest')
    else fail('生成 manifest', cards.join(','))

    // 4. 同一文件再导入必须幂等
    const again = await importer.execute({ path: FIXTURE, confirm: true, name: 'fixture' }, {})
    if (again.imported?.[0]?.status === 'exists') ok('重复导入幂等')
    else fail('重复导入幂等', JSON.stringify(again.imported?.[0]))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log(failures.length ? `\n冒烟失败：${failures.join(', ')}` : '\n冒烟通过')
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error('冒烟异常：', err?.message ?? err)
  process.exit(1)
})
