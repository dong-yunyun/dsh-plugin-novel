#!/usr/bin/env node
// 回滚：把生产联接切回上一个（或指定）发布件
//
// 设计取舍：回滚必须"随时可用"，所以这里不做完整验证——如果新发布件已经让 DSH
// 起不来，此时任何额外的严格检查都可能拦着你不让救火。只做两件最低限度的事：
//   1. 目标目录必须是一个带 release.json 的发布件（不允许切回开发目录）
//   2. 目标 index.js 必须能被 node 导入（语法/链接错误当场拒绝）
//
// 用法：
//   node scripts/rollback.mjs            # 回到上一个发布件
//   node scripts/rollback.mjs --list     # 看有哪些发布件
//   node scripts/rollback.mjs <发布件 id>
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEV_DIR, PROD_LINK } from './verify.mjs'

const RELEASES_DIR = path.join(DEV_DIR, 'releases')
const JOURNAL = path.join(RELEASES_DIR, 'index.json')

const argv = process.argv.slice(2)
const toPosix = (p) => String(p).split(path.sep).join('/')

function readJournal() {
  if (!fs.existsSync(JOURNAL)) throw new Error(`没有发布记录：${JOURNAL}（还没有 publish 过）`)
  return JSON.parse(fs.readFileSync(JOURNAL, 'utf8'))
}

function linkTarget() {
  if (!fs.existsSync(PROD_LINK)) return null
  return fs.realpathSync.native(PROD_LINK)
}

function pointProdAt(target) {
  const st = fs.lstatSync(PROD_LINK, { throwIfNoEntry: false })
  const before = linkTarget()
  if (st?.isSymbolicLink()) fs.rmdirSync(PROD_LINK)
  else if (st) throw new Error(`生产路径是真实目录，拒绝自动改动：${PROD_LINK}`)
  try {
    fs.symlinkSync(target, PROD_LINK, 'junction')
    if (linkTarget() !== target) throw new Error('切换后校验失败')
  } catch (err) {
    if (before && !fs.existsSync(PROD_LINK)) fs.symlinkSync(before, PROD_LINK, 'junction')
    throw err
  }
  return before
}

async function assertLoadable(dir) {
  const releaseFile = path.join(dir, 'release.json')
  if (!fs.existsSync(releaseFile)) throw new Error(`目标不是一个发布件（缺少 release.json）：${dir}`)
  if (toPosix(fs.realpathSync.native(dir)) === toPosix(fs.realpathSync.native(DEV_DIR))) {
    throw new Error('拒绝回滚到开发目录：闸门就是靠"生产不指向开发目录"生效的')
  }
  try {
    await import(pathToFileURL(path.join(dir, 'index.js')).href)
  } catch (err) {
    throw new Error(`目标发布件无法导入，回滚到它会二次损坏：${err?.message ?? err}`)
  }
  return JSON.parse(fs.readFileSync(releaseFile, 'utf8'))
}

async function main() {
  const journal = readJournal()

  if (argv.includes('--list')) {
    const target = linkTarget()
    console.log(`生产当前：${target ?? '(空)'}\n`)
    for (const r of journal.releases) {
      const mark = r.dir && target === fs.realpathSync.native(r.dir) ? ' ← 当前' : ''
      console.log(`  ${r.id}  ${r.at}${r.note ? `  「${r.note}」` : ''}${mark}`)
    }
    return
  }

  const wanted = argv.find((a) => !a.startsWith('--'))
  let entry
  if (wanted) {
    entry = journal.releases.find((r) => r.id === wanted || r.id.startsWith(wanted))
    if (!entry) throw new Error(`没有这个发布件：${wanted}（用 --list 查看）`)
  } else {
    // 优先回到 prev；首次发布没有 prev 时，退而求其次回到"不是当前"的最新一个
    const fallback = journal.releases.find((r) => r.id !== journal.current)
    const targetId = journal.prev ?? fallback?.id
    if (!targetId) throw new Error('只有当前这一个发布件，没有可回滚的目标（用 --list 查看）')
    entry = journal.releases.find((r) => r.id === targetId)
    if (!entry) throw new Error(`发布件 ${targetId} 的记录已被清理，请用 --list 指定`)
  }

  const dir = entry.dir ?? path.join(RELEASES_DIR, entry.id)
  const release = await assertLoadable(dir)
  const before = pointProdAt(dir)

  journal.prev = journal.current
  journal.current = release.id
  fs.writeFileSync(JOURNAL, JSON.stringify(journal, null, 2))

  console.log(`回滚完成：${before ?? '(空)'} → ${dir}`)
  console.log('重启 DSH 生效。')
}

main().catch((err) => {
  console.error(`回滚失败：${err?.message ?? err}`)
  process.exitCode = 1
})
