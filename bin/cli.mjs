#!/usr/bin/env node
/**
 * dsh-agent-team-playbook CLI
 *
 * 插件安装本身**不写用户任何文件**（skill 是只读挂载）。本命令是唯一的写文件入口，
 * 因此它必须对"覆盖用户已有文件"这件事极其保守：
 *
 *   - 每个冲突都单独询问：覆盖 / 改名 / 跳过 / 剩余全部覆盖 / 中止
 *   - 选"改名"时，写出的文件里对它的引用一并改写，不留断链
 *   - 非交互环境（CI / 管道）遇到冲突默认中止，必须显式 --force 或 --skip-conflicts
 *
 * 用法：
 *   npx dsh-agent-team-playbook init [--dir <目标目录>] [--dry-run]
 *                                     [--force | --skip-conflicts]
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'skills', 'agent-team-playbook')

/** 会被安装进用户项目的条目：playbook 本体，不含 SKILL.md（那是 skill 入口）与同步清单。 */
const ROOT_FILE = 'AGENTS.md'
const ROOT_DIR = 'docs'

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
}

function parseArgs(argv) {
  const opts = { dir: process.cwd(), dryRun: false, force: false, skipConflicts: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dir') opts.dir = path.resolve(argv[(i += 1)] ?? '.')
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force' || a === '-f') opts.force = true
    else if (a === '--skip-conflicts') opts.skipConflicts = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === 'init') continue
    else {
      console.error(`未知参数：${a}（用 --help 看用法）`)
      process.exit(2)
    }
  }
  return opts
}

function printHelp() {
  console.log(`${C.bold('dsh-agent-team-playbook init')} —— 把多智能体协作 playbook 安装到项目

${C.bold('用法')}
  npx dsh-agent-team-playbook init [选项]

${C.bold('选项')}
  --dir <路径>        目标目录（默认当前目录）
  --dry-run           只显示计划，不写任何文件
  --force, -f         冲突时全部覆盖（不询问）
  --skip-conflicts    冲突时全部跳过（不询问）
  -h, --help          显示本帮助

${C.bold('行为')}
  · 交互模式下，每个冲突单独询问：覆盖 / 改名 / 跳过 / 剩余全部覆盖 / 中止
  · 选"改名"时，文档里对它的引用会同步改写
  · 非交互模式（管道、CI）遇到冲突默认中止，不会静默覆盖
`)
}

/** 递归列出源目录下所有文件，返回相对 SOURCE_ROOT 的 posix 路径。 */
async function walk(relDir) {
  const abs = path.join(SOURCE_ROOT, relDir)
  const out = []
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = path.posix.join(relDir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/** 目标路径当前是否被占用（含"父级是文件"这种无法创建目录的情况）。 */
async function describeConflict(destAbs) {
  if (existsSync(destAbs)) {
    const s = await stat(destAbs)
    return s.isDirectory() ? '目录已存在' : '文件已存在'
  }
  // 逐级检查父目录是否是文件
  let p = path.dirname(destAbs)
  while (p && p !== path.dirname(p)) {
    if (existsSync(p)) {
      const s = await stat(p)
      if (!s.isDirectory()) return `上级 ${path.basename(p)} 是文件，无法创建目录`
      break
    }
    p = path.dirname(p)
  }
  return null
}

/** 把引用改写应用到文本内容：先改目录前缀，再改根文件名。 */
function rewriteReferences(text, renames) {
  let out = text
  for (const { from, to } of renames) {
    if (from === 'AGENTS.md') {
      // 仅替换独立出现的文件名（前后不是路径分隔或字母数字）
      out = out.replace(/(^|[^/\w.-])AGENTS\.md(?![.\w-])/g, (_m, pre) => `${pre}${to}`)
    } else {
      out = out.split(from).join(to)
    }
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) return printHelp()

  if (!existsSync(SOURCE_ROOT)) {
    console.error(C.red(`✗ 找不到包内 skill 目录：${SOURCE_ROOT}`))
    process.exit(1)
  }
  if (!existsSync(opts.dir)) {
    console.error(C.red(`✗ 目标目录不存在：${opts.dir}`))
    process.exit(1)
  }

  // ── 1. 组装安装计划 ───────────────────────────────────────────────
  const files = [{ rel: ROOT_FILE, group: ROOT_FILE }]
  for (const rel of await walk(ROOT_DIR)) files.push({ rel, group: ROOT_DIR })

  // ── 2. 检测冲突（按 group 归并，避免逐文件轰炸式提问） ──────────────
  const groups = new Map()
  for (const f of files) {
    const dest = path.join(opts.dir, f.rel)
    const reason = await describeConflict(dest)
    if (reason === null) continue
    if (!groups.has(f.group)) groups.set(f.group, { reason, files: [] })
    groups.get(f.group).files.push(f.rel)
  }

  if (groups.size === 0) {
    console.log(C.green('✓ 目标目录没有同名内容，可直接安装。'))
  } else {
    console.log(C.yellow(`⚠ 检测到 ${groups.size} 处冲突：`))
    for (const [g, info] of groups) {
      console.log(`  · ${C.bold(g)} —— ${info.reason}，影响 ${info.files.length} 个文件`)
    }
  }

  // ── 3. 逐组决定 ──────────────────────────────────────────────────
  const renames = []
  const skipped = new Set()
  const overwrite = new Set()

  const interactive = stdin.isTTY && stdout.isTTY

  if (groups.size > 0) {
    if (opts.force) {
      for (const g of groups.keys()) overwrite.add(g)
      console.log(C.dim('  --force：全部覆盖'))
    } else if (opts.skipConflicts) {
      for (const g of groups.keys()) skipped.add(g)
      console.log(C.dim('  --skip-conflicts：全部跳过'))
    } else if (!interactive) {
      console.error(C.red('\n✗ 非交互环境下检测到冲突，已中止（不会静默覆盖）。'))
      console.error('  可选：--force 全部覆盖，或 --skip-conflicts 全部跳过，或手动指定 --dir。')
      process.exit(1)
    } else {
      const rl = createInterface({ input: stdin, output: stdout })
      let overwriteRest = false
      try {
        for (const g of groups.keys()) {
          if (overwriteRest) {
            overwrite.add(g)
            continue
          }
          const isDir = g === ROOT_DIR
          console.log(`\n${C.bold('冲突：')}${g}${isDir ? '（目录）' : ''}`)
          const answer = (
            await rl.question(
              `  ${C.bold('[o]')} 覆盖   ${C.bold('[r]')} 改名   ${C.bold('[s]')} 跳过   ${C.bold('[a]')} 剩余全部覆盖   ${C.bold('[q]')} 中止 > `,
            )
          )
            .trim()
            .toLowerCase()

          if (answer === 'o') overwrite.add(g)
          else if (answer === 'a') {
            overwrite.add(g)
            overwriteRest = true
          } else if (answer === 's') skipped.add(g)
          else if (answer === 'r') {
            const suggestion = isDir ? 'docs-playbook' : 'AGENTS.team.md'
            const raw = (await rl.question(`  新名字（默认 ${suggestion}）> `)).trim() || suggestion
            const clean = raw.replace(/[/\\]/g, '-')
            if (clean === path.basename(g) || clean === '') {
              console.log(C.yellow('  名字未变化，按跳过处理。'))
              skipped.add(g)
              continue
            }
            if (isDir) renames.push({ from: `${g}/`, to: `${clean}/`, group: g })
            else renames.push({ from: g, to: clean, group: g })
            console.log(C.dim(`  → 将安装为 ${clean}，并对文档内引用同步改写`))
          } else if (answer === 'q') {
            console.log('已中止，未写入任何文件。')
            process.exit(1)
          } else {
            console.log(C.yellow('  未识别的选项，按跳过处理。'))
            skipped.add(g)
          }
        }
      } finally {
        rl.close()
      }
    }
  }

  // ── 4. 生成最终写入计划 ──────────────────────────────────────────
  const plan = []
  for (const f of files) {
    if (skipped.has(f.group)) continue
    let rel = f.rel
    for (const r of renames) {
      if (r.group !== f.group) continue
      rel = r.from === 'AGENTS.md' ? (rel === 'AGENTS.md' ? r.to : rel) : rel.startsWith(r.from) ? r.to + rel.slice(r.from.length) : rel
    }
    plan.push({ ...f, finalRel: rel, overwrite: overwrite.has(f.group) })
  }

  if (plan.length === 0) {
    console.log(C.yellow('\n没有需要写入的文件（全部跳过）。'))
    return
  }

  // ── 5. 预览 / 写入 ───────────────────────────────────────────────
  const refRenames = renames.map(({ from, to }) => ({ from, to }))
  console.log(`\n${C.bold('安装计划')}${opts.dryRun ? C.dim('（--dry-run，不会写入）') : ''}`)
  for (const item of plan) {
    const tag = item.overwrite ? C.yellow('覆盖') : item.finalRel !== item.rel ? C.green('改名') : C.dim('新增')
    console.log(`  ${tag}  ${item.finalRel}`)
  }
  if (refRenames.length > 0) {
    console.log(C.dim(`\n引用同步改写：${refRenames.map((r) => `${r.from} → ${r.to}`).join('，')}`))
  }

  if (opts.dryRun) {
    console.log(C.dim('\n（dry-run 结束）'))
    return
  }

  let written = 0
  for (const item of plan) {
    const srcAbs = path.join(SOURCE_ROOT, item.rel)
    const destAbs = path.join(opts.dir, item.finalRel)
    if (!destAbs.startsWith(opts.dir + path.sep) && destAbs !== opts.dir) {
      console.error(C.red(`✗ 拒绝写入目标目录之外的路径：${destAbs}`))
      continue
    }
    await mkdir(path.dirname(destAbs), { recursive: true })

    const isText = /\.(md|svg|txt|yml|yaml|json)$/i.test(item.rel)
    if (isText && refRenames.length > 0) {
      const text = await readFile(srcAbs, 'utf8')
      await writeFile(destAbs, rewriteReferences(text, refRenames), 'utf8')
    } else {
      await writeFile(destAbs, await readFile(srcAbs))
    }
    written += 1
  }

  console.log(C.green(`\n✓ 完成：写入 ${written} 个文件到 ${opts.dir}`))
  if (skipped.size > 0) console.log(C.yellow(`  跳过 ${skipped.size} 组冲突：${[...skipped].join(', ')}`))
  console.log(C.dim('  提示：若项目已有自己的 AGENTS.md 规则，建议把 playbook 内容合并进去而不是替换。'))
}

await main()
