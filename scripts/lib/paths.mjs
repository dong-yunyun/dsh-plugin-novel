/**
 * 路径解析：所有脚本从自身位置推导仓库根，不硬编码盘符。
 *
 * 优先用环境变量覆盖，方便在别的机器 / CI 上跑：
 *   NOVEL_WORK   作品目录（含 manifest.json）
 *   NOVEL_TERMS  内容策略词表
 *
 * 未设置时按仓库内约定自动发现：
 *   <repo>/novels/<第一个含 manifest.json 的子目录>
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（插件包根目录）。 */
export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** novels/ 目录。 */
export const NOVELS_DIR = join(PKG_DIR, 'novels')

/** 自动发现第一个已摄取的作��目录：需同时有 manifest.json 与 cards/，且跳过 _/. 开头的临时目录。 */
function discoverWork() {
  if (!existsSync(NOVELS_DIR)) return null
  const candidates = []
  for (const entry of readdirSync(NOVELS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const dir = join(NOVELS_DIR, entry.name)
    if (!existsSync(join(dir, 'manifest.json'))) continue
    if (!existsSync(join(dir, 'cards'))) continue
    candidates.push(dir)
  }
  candidates.sort()
  return candidates[0] ?? null
}

/** 当前作品目录。 */
export const WORK_DIR = process.env.NOVEL_WORK
  ? resolve(process.env.NOVEL_WORK)
  : (discoverWork() ?? join(NOVELS_DIR, 'unknown'))

/** 内容策略词表。 */
export const TERMS_FILE = process.env.NOVEL_TERMS
  ? resolve(process.env.NOVEL_TERMS)
  : join(PKG_DIR, 'sanitize', 'terms.txt')

/** 词表路径的别名（脚本里的变量名沿用 TERMS_PATH）。 */
export const TERMS_PATH = TERMS_FILE

/** 基准与参考数据目录。 */
export const REFERENCE_DIR = join(PKG_DIR, 'reference')

/**
 * 把可能是相对路径的输入解析成绝对路径。
 * 插件配置里的 novelDir 支持相对写法（相对插件包根），便于跨机器。
 */
export function resolveFromPkg(input) {
  const p = String(input ?? '')
  if (!p) return ''
  return isAbsolute(p) ? p : resolve(PKG_DIR, p)
}
