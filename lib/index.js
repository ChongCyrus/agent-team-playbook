/**
 * dsh-agent-team-playbook — DSH 命令插件（Host 半身）
 *
 * 只读命令 `/atp`（agent-team-playbook 缩写）：
 *   /atp             摘要（档位、四问、收尾三问、安装方式）
 *   /atp core        核心全文（读完即在本轮遵循）
 *   /atp paths       各分册的绝对路径
 *   /atp install     把 playbook 原子安装进当前工作区（已存在同名内容则拒绝）
 *   /atp install force  覆盖同名内容后安装（会先暂存，失败可回滚）
 *   /atp help        用法
 *
 * 命令名刻意取得短而少见：DSH 对重名命令是**硬报错**（插件加载失败），
 * 用 agent-team 这种通用词容易被其他插件或后续官方功能占用。
 *
 * @module lib/index.js
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installAtomic } from './install.js'

export const name = 'dsh-agent-team-playbook'

/** 只硬依赖命令注册表；工作区目录服务可选，缺失时回退到进程 cwd。 */
export const inject = ['commands']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLAYBOOK_DIR = path.join(PACKAGE_ROOT, 'playbook')

const USAGE = [
  '用法：/atp [core|paths|install|help]',
  '',
  '  （无参数）     规程摘要与安装方式',
  '  core           输出核心全文（约 5k 字符），读完即在本轮按它协作',
  '  paths          各分册的绝对路径，便于按需查阅',
  '  install        把 playbook 原子安装进当前工作区（有同名内容则拒绝，不覆盖）',
  '  install force  覆盖同名内容后安装（先暂存原件，失败自动回滚）',
  '  help           显示本说明',
].join('\n')

/** 摘要：纯文本（客户端把命令结果按原样渲染，用 markdown 反而难看）。 */
const SUMMARY = [
  '多智能体协作规程（agent-team-playbook）',
  '',
  '档位：快速 15–30 分钟（单点可逆、自审）｜标准 半天（S0–S6、源码级+短测）｜严格 1–2 天/子任务（全流程+红队+双重审计）',
  '',
  '动手前：验收标准可判真假？档位定了吗？方案过四问了吗——可行性 / 合理性 / 完整性 / 优越性？',
  '',
  '修复型任务：先调查根因再改，不允许「没复现就动手」。',
  '',
  '完成 = 实现 + 自检 + 证据；审计要全面系统并追到根因，别只修表象。',
  '',
  '审计产出的问题分高/中/低：高的本轮修，中低出轮，回流深度上限 1 层。',
  '',
  '收尾三问：哪里最慢？哪里最痛？哪条规则该改？有效经验必须写「已固化到哪」。',
].join('\n')

const INSTALL_HINT = [
  '—',
  '让规程变成每轮的固定上下文（本命令只是按需调用）：',
  '',
  '  /atp install                       装进当前工作区（AGENTS.md + docs/）',
  '  /atp install force                 已有同名内容时覆盖（先暂存，可回滚）',
  '  npx dsh-agent-team-playbook init --global               全局指针区块',
  '  npx dsh-agent-team-playbook init --global --inline-core 全局内联核心全文',
].join('\n')

function readPlaybook(rel) {
  const abs = path.join(PLAYBOOK_DIR, rel)
  if (!existsSync(abs)) return undefined
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return undefined
  }
}

/** 列出分册路径（用于 /atp paths）。 */
function renderPaths() {
  const rulesDir = path.join(PLAYBOOK_DIR, 'docs/workflow/rules')
  const lines = [`核心：${path.join(PLAYBOOK_DIR, 'AGENTS.md')}`, '', '分册：']
  let files = []
  try {
    files = readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort()
  } catch {
    files = []
  }
  if (files.length === 0) lines.push('  （未找到分册目录）')
  for (const f of files) lines.push(`  ${path.join(rulesDir, f)}`)
  lines.push('', `经验库：${path.join(PLAYBOOK_DIR, 'docs/workflow/practices')}`)
  return lines.join('\n')
}

/**
 * 解析工作区目录。
 *
 * **刻意不回退到 process.cwd()**：宿主进程的 cwd 可能是应用目录或 $HOME，
 * 拿它当安装目标会写到用户意料之外的地方。拿不到就明确拒绝，让用户改用 CLI 的 --dir。
 *
 * @returns {string | null}
 */
function resolveWorkspace(ctx, invocation) {
  try {
    const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    const session = invocation?.agent?.session
    if (wd && typeof wd.get === 'function' && session !== undefined) {
      const dir = wd.get(session)
      if (typeof dir === 'string' && dir.length > 0) return path.resolve(dir)
    }
  } catch {
    /* 服务不可用 → 返回 null，由调用方拒绝 */
  }
  return null
}

/** 明显不该被当作安装目标的位置（防误写）。 */
function isUnsafeTarget(dir) {
  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME ?? '', '.dsh')
  const unsafe = [PACKAGE_ROOT, dshHome, process.env.HOME ?? ''].filter(Boolean).map((p) => path.resolve(p))
  return unsafe.some((u) => dir === u)
}

async function handleInstall(ctx, rawInput, invocation) {
  const force = /\bforce\b|\b--force\b/i.test(rawInput)
  const targetDir = resolveWorkspace(ctx, invocation)

  if (targetDir === null) {
    return {
      kind: 'error',
      text: [
        '无法确定当前工作区目录，已拒绝安装（避免写到你没预期的地方）。',
        '',
        '请改用命令行并显式指定目录：',
        '  npx dsh-agent-team-playbook init --dir <你的项目路径>',
      ].join('\n'),
    }
  }
  if (isUnsafeTarget(targetDir)) {
    return {
      kind: 'error',
      text: `拒绝安装到 ${targetDir}：这看起来是 DSH 主目录或插件自身目录。请先在项目里打开会话，或用 CLI 的 --dir。`,
    }
  }

  const result = await installAtomic({
    sourceRoot: PLAYBOOK_DIR,
    targetDir,
    onConflict: force ? 'overwrite' : 'error',
  })

  if (!result.ok) {
    if (result.code === 'conflict') {
      const list = result.conflicts
        .slice(0, 6)
        .map((c) => `  · ${path.relative(targetDir, c.target)}（${c.reason}）`)
        .join('\n')
      return {
        kind: 'error',
        text: [
          `未安装：${targetDir} 已存在同名内容。`,
          list,
          result.conflicts.length > 6 ? `  ……共 ${result.conflicts.length} 处` : '',
          '',
          '可选做法：',
          '  /atp install force   覆盖（先暂存原件，失败自动回滚）',
          '  或用 CLI 交互式处理（可改名/备份）：npx dsh-agent-team-playbook init',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      }
    }
    return { kind: 'error', text: `安装失败并已回滚：${result.message}` }
  }

  const core = result.installed.find((f) => f.endsWith('AGENTS.md')) ?? 'AGENTS.md'
  const docCount = result.installed.filter((f) => f.startsWith('docs/')).length
  return {
    kind: 'success',
    text: [
      `已安装到：${targetDir}`,
      `  ${core} + docs/（${docCount} 个文件），核心与分册作为整体一起落地`,
      '',
      '工作区 AGENTS.md 会被 DSH 每轮自动注入，重载会话后生效。',
    ].join('\n'),
  }
}

/**
 * 命令处理器。
 * @returns {Promise<{kind: 'success'|'error', text: string}>|{kind:'success'|'error', text:string}}
 */
function handleCommand(ctx, invocation) {
  const raw = String(invocation?.rawInput ?? '').trim()
  const sub = raw.toLowerCase()

  if (sub === '' || sub === 'summary') {
    return { kind: 'success', text: `${SUMMARY}\n\n${INSTALL_HINT}` }
  }
  if (sub === 'help' || sub === '?') return { kind: 'success', text: USAGE }
  if (sub === 'paths') return { kind: 'success', text: renderPaths() }
  if (sub === 'core' || sub === 'full') {
    const core = readPlaybook('AGENTS.md')
    if (core === undefined) return { kind: 'error', text: `未找到核心文件：${path.join(PLAYBOOK_DIR, 'AGENTS.md')}` }
    return { kind: 'success', text: core }
  }
  if (sub === 'install' || sub.startsWith('install ')) return handleInstall(ctx, raw, invocation)

  return { kind: 'error', text: `未知参数：${raw}\n\n${USAGE}` }
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.commands.register({
    definitionId: 'dsh-agent-team-playbook',
    name: 'atp',
    description: '多智能体协作规程（agent-team-playbook）：摘要 / 核心全文 / 分册路径 / 安装到工作区',
    input: { hint: '[core|paths|install|help]' },
    handler: (invocation) => handleCommand(ctx, invocation),
  })
}

/** 供测试直接调用。 */
export { handleCommand as _handleCommand, PLAYBOOK_DIR as _PLAYBOOK_DIR }
