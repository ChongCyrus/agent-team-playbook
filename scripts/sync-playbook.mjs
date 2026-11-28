#!/usr/bin/env node
/**
 * 把仓库里的 playbook 文档同步进 playbook/ 目录，供 npm 包携带。
 *
 * 为什么要有这一步：文档的权威位置在仓库根目录（`AGENTS.md` + `docs/`），
 * 而 npm 包需要一个自包含、路径固定的副本供 CLI 安装。
 * 直接复制会漂移，所以用本脚本单向同步，并提供 `--check` 供发布前校验。
 *
 * 生成的文件清单记录在 `.synced.json`，下次同步只删自己生成的东西，
 * 绝不碰手写文件。
 *
 * 用法：
 *   node scripts/sync-playbook.mjs           # 生成/更新
 *   node scripts/sync-playbook.mjs --check   # 只校验，不一致则退出码 1
 */
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST_DIR = path.join(ROOT, 'playbook')
const MANIFEST = path.join(ROOT, '.playbook-sync.json')
const CHECK = process.argv.includes('--check')

/** 需要同步的源文件（相对仓库根），保持目录结构以让文档内的相对引用继续有效。 */
const SOURCES = [
  'AGENTS.md',
  'docs/assets/architecture.svg',
]

/** 需要同步的源目录（递归取其中所有 .md），保持目录结构。 */
const SOURCE_DIRS = [
  'docs/workflow/rules',
  'docs/workflow/practices',
]

const SKIP_DIRS = new Set(['node_modules', '.git'])

/** 递归列出目录下的 .md 文件，返回相对仓库根的路径。 */
async function listMarkdown(relDir) {
  const abs = path.join(ROOT, relDir)
  if (!existsSync(abs)) return []
  const out = []
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const rel = path.posix.join(relDir, entry.name)
    if (entry.isDirectory()) out.push(...(await listMarkdown(rel)))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel)
  }
  return out.sort()
}

/** 读旧清单，拿到上次生成了哪些文件。 */
async function readManifest() {
  if (!existsSync(MANIFEST)) return []
  try {
    const data = JSON.parse(await readFile(MANIFEST, 'utf8'))
    return Array.isArray(data.files) ? data.files : []
  } catch {
    return []
  }
}

async function main() {
  if (!CHECK) await mkdir(DEST_DIR, { recursive: true })

  const wanted = new Set(SOURCES)
  for (const dir of SOURCE_DIRS) {
    for (const rel of await listMarkdown(dir)) wanted.add(rel)
  }
  const files = [...wanted].sort()

  const previous = await readManifest()
  const stale = previous.filter((rel) => !wanted.has(rel))

  // 删除上次生成、这次不再需要的文件（只限清单里记录的，手写文件不受影响）。
  if (!CHECK) {
    for (const rel of stale) {
      await rm(path.join(DEST_DIR, rel), { force: true })
    }
  }

  const missing = []
  const drifted = []

  for (const rel of files) {
    const src = path.join(ROOT, rel)
    const dest = path.join(DEST_DIR, rel)

    if (!existsSync(src)) {
      missing.push(`源文件缺失：${rel}`)
      continue
    }

    const sourceBuf = await readFile(src)
    const same = existsSync(dest) ? (await readFile(dest)).equals(sourceBuf) : false

    if (CHECK) {
      if (!same) drifted.push(rel)
      continue
    }

    if (!same) {
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, sourceBuf)
    }
  }

  if (CHECK) {
    // 目标目录里不该有清单外的文件（防残留，例如已废弃的 SKILL.md）
    const unexpected = []
    const walkDest = async (relDir) => {
      const abs = path.join(DEST_DIR, relDir)
      if (!existsSync(abs)) return
      for (const entry of await readdir(abs, { withFileTypes: true })) {
        const rel = relDir === '' ? entry.name : path.posix.join(relDir, entry.name)
        if (entry.isDirectory()) await walkDest(rel)
        else if (!wanted.has(rel)) unexpected.push(rel)
      }
    }
    await walkDest('')
    const problems = [
      ...missing,
      ...drifted.map((rel) => `未同步：${rel}`),
      ...unexpected.map((rel) => `多余文件：${rel}`),
    ]
    if (stale.length > 0) problems.push(`残留：${stale.join(', ')}`)
    if (problems.length > 0) {
      console.error('✗ playbook/ 与源文档不一致：')
      for (const p of problems) console.error('  -', p)
      console.error('  修复：node scripts/sync-playbook.mjs')
      process.exit(1)
    }
    console.log(`✓ playbook 内容与源文档一致（${files.length} 个文件）`)
    return
  }

  await writeFile(MANIFEST, JSON.stringify({ files, generatedAt: new Date().toISOString() }, null, 2) + '\n')

  console.log(`✓ 已同步 ${files.length} 个文件到 playbook/`)
  if (stale.length > 0) console.log(`  清理 ${stale.length} 个过期文件：${stale.join(', ')}`)
  for (const m of missing) console.error('  ✗', m)
  if (missing.length > 0) process.exit(1)
}

await main()
