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
import os from 'node:os'
import { stdin, stdout } from 'node:process'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 管道被下游提前关闭（如 | head）时安静退出，不抛未捕获错误
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})
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
  const opts = {
    dir: process.cwd(),
    dryRun: false,
    force: false,
    skipConflicts: false,
    help: false,
    global: false,
    yes: false,
    inlineCore: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dir') opts.dir = path.resolve(argv[(i += 1)] ?? '.')
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force' || a === '-f') opts.force = true
    else if (a === '--skip-conflicts') opts.skipConflicts = true
    else if (a === '--global' || a === '-g') opts.global = true
    else if (a === '--yes' || a === '-y') opts.yes = true
    else if (a === '--inline-core') opts.inlineCore = true
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
  --global, -g        装成用户全局指令：复制到 $DSH_HOME/agent-team-playbook/，
                      并在 $DSH_HOME/AGENTS.md 追加一个受管区块（不覆盖原有内容）
  --inline-core       配合 --global：把核心全文内联进区块（每轮真常驻，约 3.3k tokens），
                      默认只写指针（约 200 tokens，agent 需先读一次文件）
  --yes, -y           非交互确认（--global 追加区块用）
  --dry-run           只显示计划，不写任何文件
  --force, -f         冲突时全部覆盖（不询问）
  --skip-conflicts    冲突时全部跳过（不询问）
  -h, --help          显示本帮助

${C.bold('两种安装方式的区别（重要）')}
  · 项目安装（默认）：写 <项目>/AGENTS.md + docs/。
    工作区 AGENTS.md 会被 DSH 每轮自动注入 ⇒ 成为**所有 agent 的固定上下文**。
  · 全局安装（--global）：复制到 $DSH_HOME/agent-team-playbook/，
    仅往 $DSH_HOME/AGENTS.md 追加一个受管区块（可重复执行，原地更新）。
    适用于"本机所有项目都按这套规程走"。

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

/** 受管区块标记：重复执行时原地更新，绝不碰区块外内容。 */
const BLOCK_START = '<!-- agent-team-playbook:start -->'
const BLOCK_END = '<!-- agent-team-playbook:end -->'

function managedBlock(destAbs, inlineCore, coreText) {
  const footer = '> 本节由 `npx dsh-agent-team-playbook init --global` 维护，块内内容会被自动覆盖；块外内容不受影响。'

  if (!inlineCore) {
    return [
      BLOCK_START,
      '## 多智能体协作规程（agent-team-playbook）',
      '',
      `本机所有项目按以下规程协作：\`${destAbs}/AGENTS.md\`（常驻核心，先读它）。`,
      `分册细则在 \`${destAbs}/docs/workflow/\`，按核心 §8 索引按需查阅。`,
      '',
      footer,
      BLOCK_END,
    ].join('\n')
  }

  // 内联：核心全文进区块；相对路径改写为绝对路径，保证在任意工作区都能读到
  const rewritten = coreText
    .replace(/\(^\)/, '') // 不裁剪开头
    .replace(/(^|[^/\w.-])AGENTS\.md(?![.\w-])/g, (_m, pre) => `${pre}${destAbs}/AGENTS.md`)
    .split('docs/').join(`${destAbs}/docs/`)

  return [
    BLOCK_START,
    rewritten.replace(/\s+$/, ''),
    '',
    footer,
    BLOCK_END,
  ].join('\n')
}

/**
 * 全局安装：把 playbook 复制到 $DSH_HOME/agent-team-playbook/，
 * 并只在 $DSH_HOME/AGENTS.md 里维护一个受管区块（不覆盖用户已有内容）。
 *
 * 这是让规程成为「所有工作区的常驻上下文」的唯一途径——DSH 的指令加载器只认文件，
 * 没有插件注入通道。
 */
async function runGlobalMode(opts) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const destDir = path.join(home, 'agent-team-playbook')
  const instrFile = path.join(home, 'AGENTS.md')
  const coreText = await readFile(path.join(SOURCE_ROOT, 'AGENTS.md'), 'utf8')
  const block = managedBlock(destDir, opts.inlineCore, coreText)

  const rels = [ROOT_FILE, ...(await walk(ROOT_DIR))]
  console.log(C.bold('全局安装计划'))
  console.log(C.dim(`  区块模式：${opts.inlineCore ? '内联核心全文（每轮真常驻）' : '指针（默认，agent 需先读一次文件）'}`))
  console.log(`  复制 ${rels.length} 个文件 → ${destDir}`)
  console.log(`  维护受管区块     → ${instrFile}`)

  let existing = ''
  if (existsSync(instrFile)) {
    existing = await readFile(instrFile, 'utf8')
    const hasBlock = existing.includes(BLOCK_START)
    console.log(
      C.dim(`  ${instrFile} 已存在（${existing.length} 字节），`) +
        (hasBlock ? C.green('检测到本插件的受管区块 → 原地更新') : C.yellow('没有受管区块 → 需追加')),
    )
    if (!hasBlock && !opts.yes && !opts.force) {
      if (!(stdin.isTTY && stdout.isTTY)) {
        console.error(C.red('\n✗ 该文件已存在且不含本插件区块，非交互模式下不追加。'))
        console.error('  确认可追加请加 --yes；或先手动查看该文件。')
        process.exit(1)
      }
      const rl = createInterface({ input: stdin, output: stdout })
      try {
        const a = (await rl.question(`\n在 ${instrFile} 末尾追加受管区块？（已有内容不会被改动）[y/N] > `)).trim().toLowerCase()
        if (a !== 'y' && a !== 'yes') {
          console.log('已取消，未写入任何文件。')
          process.exit(1)
        }
      } finally {
        rl.close()
      }
    }
  } else {
    console.log(C.dim(`  ${instrFile} 不存在 → 新建`))
  }

  if (opts.dryRun) {
    console.log(C.dim('\n将要追加的区块：'))
    console.log(block.split('\n').map((l) => `  ${C.dim('│')} ${l}`).join('\n'))
    console.log(C.dim('\n（--dry-run 结束）'))
    return
  }

  // 1) 复制 playbook（命名空间目录，整体刷新；不触碰用户其它文件）
  let copied = 0
  for (const rel of rels) {
    const srcAbs = path.join(SOURCE_ROOT, rel)
    const destAbs = path.join(destDir, rel)
    await mkdir(path.dirname(destAbs), { recursive: true })
    await writeFile(destAbs, await readFile(srcAbs))
    copied += 1
  }

  // 2) 维护受管区块
  let next
  if (existing.includes(BLOCK_START) && existing.includes(BLOCK_END)) {
    const re = new RegExp(`${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    next = existing.replace(re, block)
  } else if (existing.length > 0) {
    next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`
  } else {
    next = `${block}\n`
  }
  await mkdir(path.dirname(instrFile), { recursive: true })
  await writeFile(instrFile, next, 'utf8')

  console.log(C.green(`\n✓ 完成：复制 ${copied} 个文件到 ${destDir}`))
  console.log(C.green(`✓ 已维护受管区块：${instrFile}`))
  console.log(C.dim('  重载/新开会话后，所有工作区都会带上这段常驻指令。'))
  console.log(C.dim('  卸载：删掉上述两个路径，或删除 AGENTS.md 里 agent-team-playbook 标记之间的内容。'))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) return printHelp()

  if (!existsSync(SOURCE_ROOT)) {
    console.error(C.red(`✗ 找不到包内 skill 目录：${SOURCE_ROOT}`))
    process.exit(1)
  }
  if (opts.global) {
    return runGlobalMode(opts)
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
