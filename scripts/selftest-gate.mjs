#!/usr/bin/env node
// 闸门自测（回归测试）：证明闸门真的能拦住"语法没错、一跑就炸"的改动
//
// 做法：复制一份插件到临时目录，删掉 `randomUUID` 的 import（就是 2026-11-24 那次
// 真实事故），然后：
//   1. 对照组：node --check 会放行（说明语法检查不够用）
//   2. 闸门：runVerify 必须拒绝，且失败信息里要点出 randomUUID
//
// 用法：node scripts/selftest-gate.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEV_DIR, PROFILE_PATCH, runVerify } from './verify.mjs'
import { readPluginConfig } from './lib/mock-dsh.mjs'

const log = (l) => console.log('  ' + l)

function buildMutant() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-gate-'))
  for (const f of ['index.js', 'package.json', 'cordis.patch.yml', 'icon.svg']) {
    fs.copyFileSync(path.join(DEV_DIR, f), path.join(tmp, f))
  }
  for (const d of ['src', 'locale']) fs.cpSync(path.join(DEV_DIR, d), path.join(tmp, d), { recursive: true })

  const entry = path.join(tmp, 'index.js')
  const before = fs.readFileSync(entry, 'utf8')
  // 只删掉 randomUUID 这个导入名，保留同一行上的 createHash
  const withSingle = "import { randomUUID } from 'node:crypto'\n"
  const withBoth = "import { createHash, randomUUID } from 'node:crypto'\n"
  const stripped = "import { createHash } from 'node:crypto'\n"
  let after = before
  if (before.includes(withBoth)) after = before.replace(withBoth, stripped)
  else if (before.includes(withSingle)) after = before.replace(withSingle, '')
  if (after === before) throw new Error('注入失败：index.js 里已经没有可删的 randomUUID import 了，请更新本测试')
  fs.writeFileSync(entry, after)
  return tmp
}

async function main() {
  const config = readPluginConfig(PROFILE_PATCH)
  const tmp = buildMutant()
  let ok = true

  try {
    console.log('== 闸门自测 ==')

    // 语法检查层：故意放行，用来对照
    const { spawnSync } = await import('node:child_process')
    const syntax = spawnSync(process.execPath, ['--check', path.join(tmp, 'index.js')], { stdio: 'ignore' })
    if (syntax.status === 0) {
      console.log('  预期① 通过：node --check 放行这个改动（所以它当不了闸门）')
    } else {
      console.log('  ✘ 预期① 失败：node --check 竟然拦住了，说明变异方式不对')
      ok = false
    }

    // 闸门层：必须拒绝
    const mutant = await runVerify({ pkgDir: tmp, config })
    if (mutant.ok) {
      console.log('  ✘ 闸门放行了带 randomUUID 缺失的代码——闸门失效')
      ok = false
    } else {
      const failure = mutant.results.find((r) => !r.ok)
      const caught = /randomUUID/.test(failure?.detail ?? '')
      console.log(`  ${caught ? '✓' : '?'} 闸门拦住了：${failure?.id}  ${failure?.detail}`)
      if (!caught) { console.log('  ✘ 拦是拦住了，但没点出真正原因'); ok = false }
    }

    // 对照组：干净代码必须通过，否则闸门会长期误报、最终被人绕过
    const clean = await runVerify({ pkgDir: DEV_DIR, config })
    if (clean.ok) console.log(`  ✓ 干净代码 ${clean.results.length} 项全过（不会误报）`)
    else {
      const failure = clean.results.find((r) => !r.ok)
      console.log(`  ✘ 干净代码被误报：${failure?.id}  ${failure?.detail}`)
      ok = false
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  console.log(ok ? '\n自测通过：闸门能拦住已知事故，且不误报。' : '\n自测失败：闸门不可信，先修闸门。')
  process.exitCode = ok ? 0 : 1
}

main().catch((err) => {
  console.error(`自测无法进行：${err?.message ?? err}`)
  process.exitCode = 2
})
