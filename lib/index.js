/**
 * dsh-agent-team-playbook — DSH 命令插件（Host 半身）
 *
 * 提供一个只读命令 `/atp`（agent-team-playbook 缩写），把多智能体协作规程带进对话：
 *   /atp          摘要（档位、四问、收尾三问、如何装成常驻）
 *   /atp core     核心全文（读完即在本轮遵循）
 *   /atp paths    各分册的绝对路径
 *   /atp help     用法
 *
 * 命令名刻意取得短而少见：DSH 对重名命令是**硬报错**（plugin 加载失败），
 * 用 `agent-team` 这种通用词容易被其他插件或后续官方功能占用。
 *
 * 本插件**不写任何文件**。要让规程成为每个 agent 每轮的固定上下文，
 * 用 CLI 安装：`npx dsh-agent-team-playbook init`（项目级）或 `init --global`（全局）。
 *
 * 为什么不做成 skill：skill 的目录摘要会常驻占用上下文（约 300 tokens/轮），
 * 而分册本来就不会自动进上下文（只有被读取时才消耗），所以用命令按需取更划算。
 *
 * @module lib/index.js
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名（与 cordis.patch.yml 中的 name 对应）。 */
export const name = 'dsh-agent-team-playbook'

/** 只依赖命令注册表；缺失时插件不加载，不会拖累 composition。 */
export const inject = ['commands']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLAYBOOK_DIR = path.join(PACKAGE_ROOT, 'playbook')

const USAGE = [
  '用法：/atp [core|paths|help]',
  '',
  '  （无参数） 规程摘要与安装方式',
  '  core       输出核心全文（约 5k 字符），读完即在本轮按它协作',
  '  paths      各分册的绝对路径，便于按需查阅',
  '  help       显示本说明',
].join('\n')

/** 摘要：刻意短，够判断"该用哪一档、先做什么"即可。 */
const SUMMARY = [
  '## 多智能体协作规程（agent-team-playbook）',
  '',
  '**档位**：快速 15–30 分钟（单点可逆、自审）｜标准 半天（S0–S6、源码级+短测）｜严格 1–2 天/子任务（全流程+红队+双重审计）',
  '',
  '**动手前**：验收标准可判真假？档位定了吗？方案过四问了吗——可行性 / 合理性 / **完整性** / 优越性？',
  '',
  '**修复型任务**：先调查根因再改，不允许"没复现就动手"。',
  '',
  '**完成** = 实现 + 自检 + **证据**；审计要全面系统并追到根因，别只修表象。',
  '',
  '**审计产出的问题**分高/中/低：高的本轮修，中低出轮，回流深度上限 1 层。',
  '',
  '**收尾三问**：哪里最慢？哪里最痛？哪条规则该改？有效经验必须写「已固化到哪」。',
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
  const lines = [`核心：\`${path.join(PLAYBOOK_DIR, 'AGENTS.md')}\``, '', '分册：']
  if (existsSync(rulesDir)) {
    const files = readdirSafe(rulesDir).filter((f) => f.endsWith('.md')).sort()
    for (const f of files) lines.push(`  \`${path.join(rulesDir, f)}\``)
  } else {
    lines.push('  （未找到分册目录）')
  }
  lines.push('', `经验库：\`${path.join(PLAYBOOK_DIR, 'docs/workflow/practices')}\``)
  return lines.join('\n')
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 安装提示：让用户知道"摘要 ≠ 常驻"。
 */
function renderInstallHint() {
  return [
    '---',
    '**让规程变成每轮的固定上下文**（本命令只是按需调用）：',
    '',
    '```bash',
    'npx dsh-agent-team-playbook init              # 写 <项目>/AGENTS.md + docs/',
    'npx dsh-agent-team-playbook init --global     # 用户全局：受管区块（指针）',
    'npx dsh-agent-team-playbook init --global --inline-core   # 全局内联核心全文',
    '```',
  ].join('\n')
}

/**
 * 命令处理器。
 * @returns {{kind: 'success'|'error', text: string}}
 */
function handleCommand(invocation) {
  const raw = String(invocation?.rawInput ?? '').trim()
  const sub = raw.toLowerCase()

  if (sub === '' || sub === 'summary') {
    return { kind: 'success', text: `${SUMMARY}\n\n${renderInstallHint()}` }
  }
  if (sub === 'help' || sub === '?') {
    return { kind: 'success', text: USAGE }
  }
  if (sub === 'paths') {
    return { kind: 'success', text: renderPaths() }
  }
  if (sub === 'core' || sub === 'full') {
    const core = readPlaybook('AGENTS.md')
    if (core === undefined) {
      return { kind: 'error', text: `未找到核心文件：${path.join(PLAYBOOK_DIR, 'AGENTS.md')}` }
    }
    return { kind: 'success', text: core }
  }
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
    description: '多智能体协作规程（agent-team-playbook）：摘要 / 核心全文 / 分册路径（只读）',
    input: { hint: '[core|paths|help]' },
    handler: handleCommand,
  })
}

/** 供测试直接调用。 */
export { handleCommand as _handleCommand, PLAYBOOK_DIR as _PLAYBOOK_DIR }
