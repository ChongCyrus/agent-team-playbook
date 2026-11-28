#!/usr/bin/env node
/**
 * dsh-agent-team-playbook CLI
 *
 * 插件安装本身**不写用户任何文件**（插件只注册只读命令）。本命令是唯一的写文件入口，
 * 因此它必须对"覆盖用户已有文件"这件事极其保守：
 *
 *   - 每个冲突都单独询问：覆盖已有 / 改名已有（备份你的文件） / 改名我们的 / 跳过 / 中止
 *   - 选「改名我们的」时，写出的文件里对它的引用一并改写，不留断链
 *   - 选「改名已有」时，你的原文件被加上后缀保留，我们占用原路径
 *   - 非交互环境遇到冲突默认中止，必须显式 --force / --skip-conflicts / --backup-existing
 *
 * 用法：
 *   npx dsh-agent-team-playbook init [--dir <目标目录>] [--dry-run]
 *         [--force | --skip-conflicts | --backup-existing]
 *   npx dsh-agent-team-playbook init --global [--inline-core] [--yes] [--dry-run]
 */
import { createInterface } from 'node:readline/promises'
import os from 'node:os'
import { stdin, stdout } from 'node:process'
import { readFile, writeFile, mkdir, stat, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 管道被下游提前关闭（如 | head）时安静退出，不抛未捕获错误
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'playbook')

/** 会被安装进用户项目的条目：playbook 本体（核心 + 分册）。 */
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
    backupExisting: false,
    renameCore: undefined,
    renameDocs: undefined,
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
    else if (a === '--backup-existing') opts.backupExisting = true
    else if (a === '--rename-core') opts.renameCore = argv[(i += 1)]
    else if (a === '--rename-docs') opts.renameDocs = argv[(i += 1)]
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
  --backup-existing   冲突时把已有项改名为 *<后缀>，再装我们的（不询问）
  --rename-core <名>  非交互：把我们的核心装成这个名字（如 AGENTS.team.md），引用同步改写
  --rename-docs <名>  非交互：把我们的分册目录装成这个名字（如 docs-playbook），引用同步改写
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
  · 交互模式下，每个冲突单独询问：
      覆盖已有 / 改名已有（备份你的文件） / 改名我们的 / 跳过 / 剩余全部覆盖 / 中止
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

/**
 * 目标路径的冲突详情。`target` 是"改已有文件名"时要动的那个路径：
 *   - 同名文件已存在 → 改名该文件
 *   - 同名位置是目录 → 改名该目录（风险高，调用处需提示）
 *   - 上级是文件导致建不了目录 → 改名那个上级文件
 */
async function inspectConflict(destAbs) {
  if (existsSync(destAbs)) {
    const s = await stat(destAbs)
    return s.isDirectory()
      ? { reason: '同名位置已是目录', kind: 'dir', target: destAbs }
      : { reason: '文件已存在', kind: 'file', target: destAbs }
  }
  let p = path.dirname(destAbs)
  while (p && p !== path.dirname(p)) {
    if (existsSync(p)) {
      const s = await stat(p)
      if (!s.isDirectory()) return { reason: `上级 ${path.basename(p)} 是文件，无法创建目录`, kind: 'parent-file', target: p }
      break
    }
    p = path.dirname(p)
  }
  return null
}

/** 生成不冲突的备份路径。 */
function uniqueBackupPath(target, suffix) {
  let to = `${target}${suffix}`
  let i = 1
  while (existsSync(to)) to = `${target}${suffix}-${i++}`
  return to
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
      C.dim(`  ${instrFile} 已存在（${existing.length} 字符），`) +
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
    console.error(C.red(`✗ 找不到包内 playbook 目录：${SOURCE_ROOT}`))
    process.exit(1)
  }
  if (opts.global) {
    return runGlobalMode(opts)
  }

  if (!existsSync(opts.dir)) {
    console.error(C.red(`✗ 目标目录不存在：${opts.dir}`))
    process.exit(1)
  }
  if (!(await stat(opts.dir)).isDirectory()) {
    console.error(C.red(`✗ --dir 不是目录：${opts.dir}`))
    process.exit(1)
  }

  // ── 1. 组装安装单元：核心与分册是一个整体，必须同进同退 ─────────────
  const docRels = await walk(ROOT_DIR)
  if (docRels.length === 0) {
    console.error(C.red(`✗ 包内缺少分册：${path.join(SOURCE_ROOT, ROOT_DIR)} 为空或不存在`))
    process.exit(1)
  }
  const UNITS = [
    { key: ROOT_FILE, kind: 'file', files: [ROOT_FILE] },
    { key: ROOT_DIR, kind: 'dir', files: docRels },
  ]

  // ── 2. 冲突检测（按单元归并） ──────────────────────────────────────
  const conflicts = new Map()
  for (const u of UNITS) {
    for (const rel of u.files) {
      const c = await inspectConflict(path.join(opts.dir, rel))
      if (c === null) continue
      if (!conflicts.has(u.key)) conflicts.set(u.key, { kind: u.kind, targets: new Set(), files: [], reasons: new Set() })
      const entry = conflicts.get(u.key)
      entry.targets.add(c.target)
      entry.files.push(rel)
      entry.reasons.add(c.reason)
    }
  }

  if (conflicts.size === 0) {
    console.log(C.green('✓ 目标目录没有同名内容，直接安装（核心 + 分册一起）。'))
  } else {
    console.log(C.yellow('⚠ 检测到冲突（核心与分册必须一起装，所以下面整体决策）：'))
    for (const [key, info] of conflicts) {
      console.log(`  · ${C.bold(key)} —— ${[...info.reasons].join('；')}，涉及 ${info.files.length} 个文件`)
      for (const target of info.targets) console.log(C.dim(`      已有：${path.relative(opts.dir, target)}`))
    }
  }

  // ── 3. 决策（只有"整体"的选项，不存在装一半） ──────────────────────
  const renames = [] // 我们这侧的改名（会同步改写引用）
  const existingRenames = [] // 已有项改名备份
  const defaultSuffix = `.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  let install = true
  const interactive = stdin.isTTY && stdout.isTTY

  const backupAll = (suffix) => {
    for (const [, info] of conflicts) {
      for (const target of info.targets) {
        existingRenames.push({ from: target, to: uniqueBackupPath(target, suffix) })
      }
    }
  }

  // 非交互显式改名：只要每个冲突单元都被覆盖，就不再提问
  if (opts.renameCore !== undefined) {
    if (!/^[^/\\]+$/.test(opts.renameCore)) { console.error(C.red('✗ --rename-core 不能含路径分隔符')); process.exit(1) }
    if (opts.renameCore === ROOT_FILE) { console.error(C.red(`✗ --rename-core 不能与原名相同`)); process.exit(1) }
    if (existsSync(path.join(opts.dir, opts.renameCore))) {
      console.error(C.red(`✗ --rename-core 目标已存在：${opts.renameCore}`)); process.exit(1)
    }
    renames.push({ from: ROOT_FILE, to: opts.renameCore })
  }
  if (opts.renameDocs !== undefined) {
    if (!/^[^/\\]+$/.test(opts.renameDocs)) { console.error(C.red('✗ --rename-docs 不能含路径分隔符')); process.exit(1) }
    if (opts.renameDocs === ROOT_DIR) { console.error(C.red(`✗ --rename-docs 不能与原名相同`)); process.exit(1) }
    if (existsSync(path.join(opts.dir, opts.renameDocs))) {
      console.error(C.red(`✗ --rename-docs 目标已存在：${opts.renameDocs}`)); process.exit(1)
    }
    renames.push({ from: `${ROOT_DIR}/`, to: `${opts.renameDocs}/` })
  }
  const unresolved = [...conflicts.keys()].filter(
    (k) => !renames.some((r) => (k === ROOT_FILE ? r.from === ROOT_FILE : r.from === `${ROOT_DIR}/`)),
  )
  // 显式改名时提示一下（用户可能以为必须冲突才会改名）
  for (const r of renames) {
    if (r.from === ROOT_FILE && !conflicts.has(ROOT_FILE)) console.log(C.dim(`  --rename-core：核心将装成 ${r.to}（原路径未冲突，仍按你的要求改名）`))
    if (r.from === `${ROOT_DIR}/` && !conflicts.has(ROOT_DIR)) console.log(C.dim(`  --rename-docs：分册将装到 ${r.to}/（原路径未冲突，仍按你的要求改名）`))
  }
  if (conflicts.size > 0 && unresolved.length === 0) {
    console.log(C.dim(`  已按 --rename-* 处理全部冲突：${renames.map((r) => `${r.from} → ${r.to}`).join('，')}`))
  }

  if (unresolved.length > 0) {
    if (opts.force) {
      console.log(C.dim('  --force：覆盖已有内容'))
    } else if (opts.skipConflicts) {
      install = false
      console.log(C.dim('  --skip-conflicts：整体跳过（不会只装一半）'))
    } else if (opts.backupExisting) {
      backupAll(defaultSuffix)
      console.log(C.dim(`  --backup-existing：已有冲突项改名为 *${defaultSuffix} 后安装`))
    } else if (!interactive) {
      console.error(C.red('\n✗ 非交互环境下检测到冲突，已中止（不会静默覆盖，也不会只装一半）。'))
      console.error('  可选：--force 覆盖｜--skip-conflicts 跳过（整体不装）｜--backup-existing 备份已有项后安装。')
      process.exit(1)
    } else {
      const rl = createInterface({ input: stdin, output: stdout })
      try {
        const answer = (
          await rl.question(
            `\n${C.bold('怎么处理？')}  ${C.bold('[o]')} 覆盖已有   ${C.bold('[e]')} 改名已有   ${C.bold('[r]')} 改名我们的   ${C.bold('[s]')} 跳过（整体不装）   ${C.bold('[q]')} 中止 > `,
          )
        )
          .trim()
          .toLowerCase()

        if (answer === 'o') {
          // 覆盖
        } else if (answer === 'e') {
          const suffix = (await rl.question(`  给已有项加的后缀（默认 ${defaultSuffix}）> `)).trim() || defaultSuffix
          if (!/^[.A-Za-z0-9_-]+$/.test(suffix)) {
            console.error(C.red('  后缀只能含字母数字点下划线横线，已中止。'))
            process.exit(1)
          }
          backupAll(suffix)
        } else if (answer === 'r') {
          // 只对我们这侧改名：逐个冲突单元问
          for (const key of conflicts.keys()) {
            const suggestion = key === ROOT_DIR ? 'docs-playbook' : 'AGENTS.team.md'
            const raw = (await rl.question(`  ${key} 的新名字（默认 ${suggestion}）> `)).trim() || suggestion
            const clean = raw.replace(/[/\\]/g, '-')
            if (clean === path.basename(key) || clean === '') {
              console.error(C.red('  名字未变化，已中止。'))
              process.exit(1)
            }
            if (key === ROOT_DIR) renames.push({ from: `${key}/`, to: `${clean}/` })
            else renames.push({ from: key, to: clean })
            console.log(C.dim(`  → ${key} 将安装为 ${clean}，文档内引用同步改写`))
          }
        } else if (answer === 's') {
          install = false
        } else {
          console.log('已中止，未写入任何文件。')
          process.exit(1)
        }
      } finally {
        rl.close()
      }
    }
  }

  if (!install) {
    console.log(C.yellow('\n已跳过：核心与分册都没有安装（不产生半成品）。'))
    return
  }

  // ── 4. 生成最终计划（改名会同步改写引用） ──────────────────────────
  const plan = []
  for (const u of UNITS) {
    for (const rel of u.files) {
      let finalRel = rel
      for (const r of renames) {
        if (r.from === ROOT_FILE) {
          if (finalRel === ROOT_FILE) finalRel = r.to
        } else if (finalRel.startsWith(r.from)) {
          finalRel = r.to + finalRel.slice(r.from.length)
        }
      }
      plan.push({ srcRel: rel, finalRel })
    }
  }

  const refRenames = renames.map(({ from, to }) => ({ from, to }))
  console.log(`\n${C.bold('安装计划')}${opts.dryRun ? C.dim('（--dry-run，不会写入）') : ''}  —— 共 ${plan.length} 个文件，整体生效`)
  for (const item of plan.slice(0, 3)) console.log(`  ${C.dim('新增')}  ${item.finalRel}`)
  if (plan.length > 6) console.log(C.dim(`  …… 中间 ${plan.length - 6} 个文件省略……`))
  for (const item of plan.slice(-3)) console.log(`  ${C.dim('新增')}  ${item.finalRel}`)
  if (refRenames.length > 0) console.log(C.dim(`引用同步改写：${refRenames.map((r) => `${r.from} → ${r.to}`).join('，')}`))
  if (existingRenames.length > 0) {
    console.log(C.dim(`已有项改名：${existingRenames.map((r) => `${path.relative(opts.dir, r.from)} → ${path.relative(opts.dir, r.to)}`).join('，')}`))
  }

  if (opts.dryRun) {
    console.log(C.dim('\n（dry-run 结束，未写入任何文件）'))
    return
  }

  // ── 5. 暂存 → 提交 → 失败回滚（保证要么全有、要么全无） ─────────────
  const stageRoot = path.join(opts.dir, `.atp-stage-${process.pid}-${Date.now()}`)
  const stashRoot = path.join(stageRoot, '.rollback')
  const committed = []
  const madeDirs = []
  const doneBackups = []
  const stashed = [] // 被覆盖的原件：安装失败时还原

  const cleanupStage = async () => {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
  }

  const rollback = async () => {
    for (const f of committed.reverse()) {
      await rm(f, { force: true, recursive: true }).catch(() => {})
    }
    for (const s of stashed.reverse()) {
      await mkdir(path.dirname(s.from), { recursive: true }).catch(() => {})
      await rename(s.to, s.from).catch(() => {})
    }
    for (const r of doneBackups.reverse()) {
      await rename(r.to, r.from).catch(() => {})
    }
    for (const d of madeDirs.reverse()) {
      await rmdir(d).catch(() => {})
    }
    await cleanupStage()
  }

  try {
    // 5.1 全部写进暂存目录（此时用户目录还没被改动）
    for (const item of plan) {
      const dest = path.join(stageRoot, item.finalRel)
      await mkdir(path.dirname(dest), { recursive: true })
      const srcAbs = path.join(SOURCE_ROOT, item.srcRel)
      const isText = /\.(md|svg|txt|yml|yaml|json)$/i.test(item.srcRel)
      if (isText && refRenames.length > 0) {
        await writeFile(dest, rewriteReferences(await readFile(srcAbs, 'utf8'), refRenames), 'utf8')
      } else {
        await writeFile(dest, await readFile(srcAbs))
      }
    }

    // 5.2 备份"已有项"（改名腾出原路径）
    for (const r of existingRenames) {
      await mkdir(path.dirname(r.to), { recursive: true })
      await rename(r.from, r.to)
      doneBackups.push(r)
    }

    // 5.3 覆盖前先"暂存"原件：这样即使后面失败，也能原样还原，不会丢用户数据
    const planDestSet = new Set(plan.map((i) => path.join(opts.dir, i.finalRel)))
    for (const [, info] of conflicts) {
      for (const target of info.targets) {
        if (!existsSync(target)) continue // 已被 [e] 备份走
        if (!planDestSet.has(target)) continue // 我们改了自己的名字，没占用这个路径 → 不动用户文件
        const rel = path.relative(opts.dir, target)
        const to = path.join(stashRoot, rel)
        await mkdir(path.dirname(to), { recursive: true })
        await rename(target, to)
        stashed.push({ from: target, to })
      }
    }

    // 5.4 提交：逐个 rename 到最终位置
    for (const item of plan) {
      const dest = path.join(opts.dir, item.finalRel)
      if (!dest.startsWith(opts.dir + path.sep)) throw new Error(`拒绝写入目标目录之外：${dest}`)
      let dir = path.dirname(dest)
      const missingDirs = []
      while (!existsSync(dir)) {
        missingDirs.unshift(dir)
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      for (const d of missingDirs) {
        await mkdir(d)
        madeDirs.push(d)
      }
      await rename(path.join(stageRoot, item.finalRel), dest)
      committed.push(dest)
      // 仅测试用故障注入：验证"中途失败也能完整回滚"
      const failAfter = Number(process.env.ATP_FAIL_AFTER_COMMITS ?? 0)
      if (failAfter > 0 && committed.length === failAfter) {
        throw new Error(`injected failure after ${failAfter} commits (ATP_FAIL_AFTER_COMMITS)`)
      }
    }

    // 5.5 校验：所有文件都在位，且核心与分册都不缺
    const missingAfter = plan.filter((i) => !existsSync(path.join(opts.dir, i.finalRel)))
    if (missingAfter.length > 0) {
      throw new Error(`提交后缺少 ${missingAfter.length} 个文件：${missingAfter.map((i) => i.finalRel).join(', ')}`)
    }
    const coreRelFinal = plan.find((i) => i.srcRel === ROOT_FILE)?.finalRel
    const docRelFinal = plan.find((i) => i.srcRel === `${ROOT_DIR}/workflow/rules/03-流水线.md`)?.finalRel
    if (coreRelFinal === undefined || docRelFinal === undefined || !existsSync(path.join(opts.dir, coreRelFinal)) || !existsSync(path.join(opts.dir, docRelFinal))) {
      throw new Error('核心与分册没有同时落地')
    }
  } catch (error) {
    console.error(C.red(`\n✗ 安装失败，正在回滚：${error.message}`))
    await rollback()
    console.error(C.red('  已回滚到安装前状态，未留下半成品。'))
    process.exit(1)
  }

  await cleanupStage()
  console.log(C.green(`\n✓ 完成：${plan.length} 个文件已原子安装到 ${opts.dir}`))
  if (existingRenames.length > 0) console.log(C.yellow(`  你的原文件已保留为：${existingRenames.map((r) => path.relative(opts.dir, r.to)).join('，')}`))
  console.log(C.dim('  提示：若项目已有自己的协作规则，建议把它们合并进新的 AGENTS.md，而不是两份并存。'))
}

await main()
