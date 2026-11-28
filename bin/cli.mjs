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
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installAtomic, scan, listFiles, CORE_FILE, DOCS_DIR } from '../lib/install.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 管道被下游提前关闭（如 | head）时安静退出，不抛未捕获错误
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'playbook')

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

  const rels = [CORE_FILE, ...(await listFiles(SOURCE_ROOT, DOCS_DIR))]
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
  if (opts.global) return runGlobalMode(opts)

  if (!existsSync(opts.dir)) {
    console.error(C.red(`✗ 目标目录不存在：${opts.dir}`))
    process.exit(1)
  }
  if (!(await stat(opts.dir)).isDirectory()) {
    console.error(C.red(`✗ --dir 不是目录：${opts.dir}`))
    process.exit(1)
  }
  if ((await listFiles(SOURCE_ROOT, DOCS_DIR)).length === 0) {
    console.error(C.red(`✗ 包内缺少分册：${path.join(SOURCE_ROOT, DOCS_DIR)} 为空或不存在`))
    process.exit(1)
  }

  // ── 1. 扫描冲突（核心 + 分册是一个不可分单元） ────────────────────
  const { conflicts } = await scan({ sourceRoot: SOURCE_ROOT, targetDir: opts.dir })
  const byUnit = new Map()
  for (const c of conflicts) {
    if (!byUnit.has(c.unit)) byUnit.set(c.unit, { reasons: new Set(), targets: new Set(), count: 0 })
    const e = byUnit.get(c.unit)
    e.reasons.add(c.reason)
    e.targets.add(c.target)
    e.count += 1
  }

  if (conflicts.length === 0) {
    console.log(C.green('✓ 目标目录没有同名内容，直接安装（核心 + 分册一起）。'))
  } else {
    console.log(C.yellow('⚠ 检测到冲突（核心与分册必须一起装，所以下面整体决策）：'))
    for (const [unit, info] of byUnit) {
      console.log(`  · ${C.bold(unit)} —— ${[...info.reasons].join('；')}，涉及 ${info.count} 个文件`)
      for (const target of info.targets) console.log(C.dim(`      已有：${path.relative(opts.dir, target)}`))
    }
  }

  // ── 2. 决策 ────────────────────────────────────────────────────────
  const renames = []
  const defaultSuffix = `.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  let onConflict = 'proceed'
  let backupAllConflicts = false
  let backupSuffix
  let install = true
  const interactive = stdin.isTTY && stdout.isTTY

  // 非交互显式改名
  if (opts.renameCore !== undefined) {
    if (!/^[^/\\]+$/.test(opts.renameCore) || opts.renameCore === CORE_FILE) {
      console.error(C.red('✗ --rename-core 非法（不能含路径分隔符，也不能与原名相同）'))
      process.exit(1)
    }
    if (existsSync(path.join(opts.dir, opts.renameCore))) {
      console.error(C.red(`✗ --rename-core 目标已存在：${opts.renameCore}`))
      process.exit(1)
    }
    renames.push({ from: CORE_FILE, to: opts.renameCore })
  }
  if (opts.renameDocs !== undefined) {
    if (!/^[^/\\]+$/.test(opts.renameDocs) || opts.renameDocs === DOCS_DIR) {
      console.error(C.red('✗ --rename-docs 非法（不能含路径分隔符，也不能与原名相同）'))
      process.exit(1)
    }
    if (existsSync(path.join(opts.dir, opts.renameDocs))) {
      console.error(C.red(`✗ --rename-docs 目标已存在：${opts.renameDocs}`))
      process.exit(1)
    }
    renames.push({ from: `${DOCS_DIR}/`, to: `${opts.renameDocs}/` })
  }
  if (renames.length > 0) {
    console.log(C.dim(`  按 --rename-* 处理：${renames.map((r) => `${r.from} → ${r.to}`).join('，')}`))
  }

  // 未被改名覆盖的冲突才需要决策
  const unresolved = conflicts.filter(
    (c) => !renames.some((r) => (c.unit === CORE_FILE ? r.from === CORE_FILE : r.from === `${DOCS_DIR}/`)),
  )

  if (unresolved.length > 0) {
    if (opts.force) {
      console.log(C.dim('  --force：覆盖已有内容'))
    } else if (opts.skipConflicts) {
      install = false
      console.log(C.dim('  --skip-conflicts：整体跳过（不会只装一半）'))
    } else if (opts.backupExisting) {
      backupAllConflicts = true
      backupSuffix = defaultSuffix
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
          backupAllConflicts = true
          backupSuffix = suffix
        } else if (answer === 'r') {
          for (const unit of new Set(unresolved.map((c) => c.unit))) {
            const suggestion = unit === DOCS_DIR ? 'docs-playbook' : 'AGENTS.team.md'
            const raw = (await rl.question(`  ${unit} 的新名字（默认 ${suggestion}）> `)).trim() || suggestion
            const clean = raw.replace(/[/\\]/g, '-')
            if (clean === path.basename(unit) || clean === '') {
              console.error(C.red('  名字未变化，已中止。'))
              process.exit(1)
            }
            if (unit === DOCS_DIR) renames.push({ from: `${unit}/`, to: `${clean}/` })
            else renames.push({ from: unit, to: clean })
            console.log(C.dim(`  → ${unit} 将安装为 ${clean}，文档内引用同步改写`))
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

  // ── 3. 预览 ────────────────────────────────────────────────────────
  const preview = renames.length > 0 ? `（改名：${renames.map((r) => `${r.from} → ${r.to}`).join('，')}）` : ''
  console.log(`\n${C.bold('安装计划')}${opts.dryRun ? C.dim('（--dry-run，不会写入）') : ''}${C.dim(preview)}`)
  console.log(C.dim(`  ${CORE_FILE} + ${DOCS_DIR}/ 作为整体一起安装；冲突策略：${onConflict}${backupSuffix ? `（后缀 ${backupSuffix}）` : ''}`))

  if (opts.dryRun) {
    console.log(C.dim('\n（dry-run 结束，未写入任何文件）'))
    return
  }

  // ── 4. 原子安装（暂存 → 提交 → 失败回滚） ────────────────────────
  const result = await installAtomic({
    sourceRoot: SOURCE_ROOT,
    targetDir: opts.dir,
    onConflict,
    renames,
    backupTargets: backupAllConflicts ? conflicts.map((c) => c.target) : [],
    backupSuffix,
  })

  if (!result.ok) {
    if (result.code === 'conflict') {
      console.error(C.red(`\n✗ 失败：${result.message}`))
      process.exit(1)
    }
    console.error(C.red(`\n✗ 安装失败，已回滚到安装前状态：${result.message}`))
    process.exit(1)
  }

  console.log(C.green(`\n✓ 完成：${result.installed.length} 个文件已原子安装到 ${opts.dir}`))
  if (result.backups.length > 0) {
    console.log(C.yellow(`  你的原文件已保留为：${result.backups.map((b) => path.relative(opts.dir, b.to)).join('，')}`))
  }
  console.log(C.dim('  提示：若项目已有自己的协作规则，建议把它们合并进新的 AGENTS.md，而不是两份并存。'))
}

await main()
