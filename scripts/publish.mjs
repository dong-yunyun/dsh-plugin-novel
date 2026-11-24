#!/usr/bin/env node
// 发布闸门：验证 → 冻结成发布件 → 只让"发布件"上线
//
// 生产环境（DSH profile 的 node_modules/dsh-novel-helper）是一个目录联接。
// 以前它直接指向开发目录 D:\codetest\novel-plugin，所以"保存即上线"，
// 一次手误就能让 DSH 起不来。从这里开始，它只指向 releases/<id>，
// 而 releases/<id> 只有在完好通过 verify 之后才会被创建。
//
// 用法：
//   node scripts/publish.mjs                 # 只验证 + 打包，不动生产
//   node scripts/publish.mjs --apply         # 验证通过后切换到新发布件
//   node scripts/publish.mjs --apply --note "修 randomUUID"
//   node scripts/publish.mjs --status        # 生产现在指向谁
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  DEV_DIR, PROD_LINK, PROFILE_PATCH, runVerify, listShippedFiles, isProdPointingAtDev,
} from './verify.mjs'
import { readPluginConfig } from './lib/mock-dsh.mjs'

const RELEASES_DIR = path.join(DEV_DIR, 'releases')
const JOURNAL = path.join(RELEASES_DIR, 'index.json')
const KEEP = 5

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const relJoin = (base, rel) => path.join(base, ...rel.split('/'))

function readJournal() {
  if (!fs.existsSync(JOURNAL)) return { current: null, releases: [] }
  return JSON.parse(fs.readFileSync(JOURNAL, 'utf8'))
}

function writeJournal(j) {
  fs.mkdirSync(RELEASES_DIR, { recursive: true })
  fs.writeFileSync(JOURNAL, JSON.stringify(j, null, 2))
}

function linkTarget() {
  if (!fs.existsSync(PROD_LINK)) return null
  return fs.realpathSync.native(PROD_LINK)
}

/** 只摘掉联接点本身，绝不递归进目标目录。 */
function unlinkProd() {
  const st = fs.lstatSync(PROD_LINK, { throwIfNoEntry: false })
  if (!st) return
  if (!st.isSymbolicLink()) {
    throw new Error(`生产路径不是目录联接而是真实目录，拒绝自动改动：${PROD_LINK}`)
  }
  fs.rmdirSync(PROD_LINK)
}

function pointProdAt(target) {
  const before = linkTarget()
  unlinkProd()
  try {
    fs.symlinkSync(target, PROD_LINK, 'junction')
    const after = linkTarget()
    if (after !== target) throw new Error(`切换后校验失败：期望 ${target}，实际 ${after}`)
  } catch (err) {
    // 回滚联接，绝不把生产留在"悬空"状态
    try {
      if (before && !fs.existsSync(PROD_LINK)) fs.symlinkSync(before, PROD_LINK, 'junction')
    } catch { /* 回滚也失败：下面的错误信息会让用户手工修 */ }
    throw err
  }
  return before
}

function makeReleaseId() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const digest = sha256(path.join(DEV_DIR, 'index.js')).slice(0, 6)
  return `${stamp}-${digest}`
}

function copyRelease(id, shipped) {
  const dir = path.join(RELEASES_DIR, id)
  if (fs.existsSync(dir)) throw new Error(`发布目录已存在：${dir}`)
  fs.mkdirSync(dir, { recursive: true })

  const files = {}
  for (const rel of ['package.json', ...shipped]) {
    const src = relJoin(DEV_DIR, rel)
    const dst = relJoin(dir, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    files[rel] = sha256(dst)
  }

  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({
    id,
    at: new Date().toISOString(),
    source: DEV_DIR,
    note: val('note', ''),
    files,
  }, null, 2))
  return { dir, files }
}

function prune(journal) {
  const keep = new Set([journal.current, journal.prev, ...journal.releases.slice(0, KEEP).map((r) => r.id)])
  keep.delete(null)
  const removed = []
  for (const r of journal.releases) {
    if (keep.has(r.id)) continue
    const dir = path.join(RELEASES_DIR, r.id)
    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(r.id) }
  }
  journal.releases = journal.releases.filter((r) => keep.has(r.id))

  // 没进账的目录（试发布、验证失败残留）一并清掉；生产正在用的那个绝不动
  const target = linkTarget()
  for (const entry of fs.readdirSync(RELEASES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (journal.releases.some((r) => r.id === entry.name)) continue
    const dir = path.join(RELEASES_DIR, entry.name)
    if (target && fs.realpathSync.native(dir) === target) continue
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

async function main() {
  fs.mkdirSync(RELEASES_DIR, { recursive: true })

  if (has('status')) {
    const journal = readJournal()
    const target = linkTarget()
    const rel = fs.existsSync(path.join(target ?? '', 'release.json'))
      ? JSON.parse(fs.readFileSync(path.join(target, 'release.json'), 'utf8'))
      : null
    console.log(`生产联接：${PROD_LINK}`)
    console.log(`  指向    ：${target ?? '(不存在)'}`)
    console.log(`  发布件  ：${rel ? `${rel.id}（${rel.at}）` : '无签署记录'}`)
    if (isProdPointingAtDev()) {
      console.log('  状态    ：⚠ 仍指向开发目录，任何保存都会直接上线（未受闸门保护）')
      process.exitCode = 1
    } else {
      console.log('  状态    ：✔ 已指向不可变发布件')
    }
    console.log(`  历史    ：${journal.releases.length} 个发布件`)
    return
  }

  const config = readPluginConfig(val('profile', PROFILE_PATCH))

  console.log('── 1/3 验证开发目录 ──')
  const devCheck = await runVerify({ pkgDir: DEV_DIR, config, log: (l) => console.log('  ' + l) })
  if (!devCheck.ok) {
    console.error('\n✘ 阻断：开发目录未通过验证，没有产生任何发布件，生产未改动。')
    process.exitCode = 1
    return
  }

  console.log('\n── 2/3 冻结发布件并复验 ──')
  const id = makeReleaseId()
  const { pkg } = listShippedFiles(DEV_DIR)
  let release
  try {
    release = copyRelease(id, listShippedFiles(DEV_DIR).shipped)
    const relCheck = await runVerify({ pkgDir: release.dir, config, log: (l) => console.log('  ' + l) })
    if (!relCheck.ok) {
      fs.rmSync(release.dir, { recursive: true, force: true })
      console.error('\n✘ 阻断：发布件复验失败（多半是 package.json 的 files 漏了文件）。已删除该发布件，生产未改动。')
      process.exitCode = 1
      return
    }
  } catch (err) {
    if (release?.dir) fs.rmSync(release.dir, { recursive: true, force: true })
    throw err
  }
  console.log(`  发布件：${release.dir}`)
  console.log(`  文件数：${Object.keys(release.files).length}  ${pkg.name}@${pkg.version}`)

  if (!has('apply')) {
    console.log('\n✔ 验证通过，已冻结发布件，但未切换生产（加 --apply 才切换）')
    return
  }

  console.log('\n── 3/3 切换生产 ──')
  const prev = pointProdAt(release.dir)
  const journal = readJournal()
  journal.prev = journal.current
  journal.current = id
  journal.releases.unshift({ id, at: new Date().toISOString(), dir: release.dir, note: val('note', ''), prev })
  const removed = prune(journal)
  writeJournal(journal)

  console.log(`  生产：${prev ?? '(无)'} → ${release.dir}`)
  console.log(`  回滚：node scripts/rollback.mjs`)
  if (removed.length) console.log(`  清理：${removed.length} 个过期发布件`)
  console.log('\n✔ 完成。重启 DSH 后生效；重启失败可立刻执行 rollback。')
}

main().catch((err) => {
  console.error(`\n✘ 发布失败：${err?.message ?? err}`)
  process.exitCode = 1
})
