/**
 * 原子安装逻辑（CLI 与 /atp 命令共用）
 *
 * 设计约束：
 *   - **核心与分册是一个不可分单元**：要么都装，要么都不装
 *   - **暂存 → 提交 → 回滚**：提交前不动用户目录；任何一步失败完整还原
 *   - 覆盖前把原件暂存进 stage，成功才丢弃（否则可能丢用户数据）
 *
 * 本模块不打印、不读 TTY，只返回结构化结果，方便 CLI 与命令各自渲染。
 *
 * @module lib/install
 */
import { readFile, writeFile, mkdir, stat, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 会被安装进用户项目的单元：核心文件 + 分册目录。 */
/** 我们自己写下的核心文件里必然出现的签名，用于识别「已安装 / 已改名安装」。 */
export const OURS_SIGNATURE = '# AGENTS.md（常驻核心'
export const CORE_FILE = 'AGENTS.md'
export const DOCS_DIR = 'docs'

/** 内容是否属于需要改写引用的文本类型。 */
const TEXT_RE = /\.(md|svg|txt|yml|yaml|json)$/i

/** 递归列出目录下所有文件（相对 given 目录的 posix 路径）。 */
export async function listFiles(rootDir, relDir) {
  const abs = path.join(rootDir, relDir)
  const out = []
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = path.posix.join(relDir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(rootDir, rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/**
 * 检测目标路径的冲突。`target` 是"改已有项"时要动的路径。
 * @returns {Promise<null | {reason: string, kind: 'file'|'dir'|'parent-file', target: string}>}
 */
/**
 * 判断一个目标路径是否构成"冲突"。
 *
 * 关键：**内容完全相同不算冲突**。否则重复安装时会把上一次装好的我们自己的文件
 * 也报成冲突（用户看到"15 处同名内容"却全是自己刚装的），既困惑又阻碍幂等。
 *
 * @param {string} destAbs 目标绝对路径
 * @param {string} [sourceAbs] 对应源文件绝对路径；给了就做内容比对
 */
export async function inspectConflict(destAbs, sourceAbs) {
  if (existsSync(destAbs)) {
    const s = await stat(destAbs)
    if (s.isDirectory()) return { reason: '同名位置已是目录', kind: 'dir', target: destAbs }
    if (typeof sourceAbs === 'string' && existsSync(sourceAbs)) {
      try {
        const src = await readFile(sourceAbs)
        const dst = await readFile(destAbs)
        if (src.length === dst.length && src.equals(dst)) return null
      } catch {
        /* 读不了就按冲突处理（保守） */
      }
    }
    // 内容不同：区分「用户自己的文件」与「本插件之前装的（引用已按改名改写）」
    let ours = false
    try {
      ours = (await readFile(destAbs, 'utf8')).includes(OURS_SIGNATURE)
    } catch {
      /* 读不了就当不是我们的 */
    }
    return {
      reason: ours ? '本插件之前装的版本（引用已按改名改写）' : '文件内容不同',
      kind: 'file',
      target: destAbs,
      ours,
    }
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
export function uniqueBackupPath(target, suffix) {
  let to = `${target}${suffix}`
  let i = 1
  while (existsSync(to)) to = `${target}${suffix}-${i++}`
  return to
}

/** 把引用改写应用到文本：目录前缀改完再改根文件名。 */
export function rewriteReferences(text, renames) {
  let out = text
  for (const { from, to } of renames) {
    if (from === CORE_FILE) {
      out = out.replace(/(^|[^/\w.-])AGENTS\.md(?![.\w-])/g, (_m, pre) => `${pre}${to}`)
    } else {
      out = out.split(from).join(to)
    }
  }
  return out
}

/**
 * 扫描安装单元并返回冲突摘要。
 * @param {{sourceRoot: string, targetDir: string}} args
 */
export async function scan({ sourceRoot, targetDir }) {
  const docRels = await listFiles(sourceRoot, DOCS_DIR)
  const units = [
    { key: CORE_FILE, kind: 'file', files: [CORE_FILE] },
    { key: DOCS_DIR, kind: 'dir', files: docRels },
  ]
  const conflicts = []
  for (const u of units) {
    for (const rel of u.files) {
      const c = await inspectConflict(path.join(targetDir, rel), path.join(sourceRoot, rel))
      if (c !== null) conflicts.push({ unit: u.key, rel, ...c })
    }
  }
  return { units, docRels, conflicts }
}

/**
 * 原子安装。
 *
 * @param {object} args
 * @param {string} args.sourceRoot 包内 playbook 目录
 * @param {string} args.targetDir 目标工作区
 * @param {'error'|'proceed'} args.onConflict 冲突时是拒绝还是继续
 * @param {string[]} [args.backupTargets] 需要"备份（改名保留）"的已有路径（绝对路径）
 * @param {string} [args.backupSuffix] 备份后缀
 * @param {Array<{from: string, to: string}>} [args.renames] 我们这侧的改名（会改写引用）
 * @param {(phase: string, detail?: any) => void} [args.onProgress] 进度回调（可选）
 * @returns {Promise<{ok: boolean, code?: 'conflict'|'failed', message?: string,
 *                    installed: string[], backups: Array<{from:string,to:string}>,
 *                    conflicts?: any[]}>}
 */
export async function installAtomic({ sourceRoot, targetDir, onConflict, renames = [], backupTargets = [], backupSuffix, onProgress = () => {} }) {
  const scanned = await scan({ sourceRoot, targetDir })
  const { units, docRels, conflicts } = scanned

  if (docRels.length === 0) {
    return { ok: false, code: 'failed', message: `包内缺少分册：${path.join(sourceRoot, DOCS_DIR)}`, installed: [], backups: [] }
  }

  if (conflicts.length > 0) {
    if (onConflict === 'error') {
      return { ok: false, code: 'conflict', message: '目标已存在同名内容', conflicts, installed: [], backups: [] }
    }
  }

  // 1. 计划
  const plan = []
  for (const u of units) {
    for (const rel of u.files) {
      let finalRel = rel
      for (const r of renames) {
        if (r.from === CORE_FILE) {
          if (finalRel === CORE_FILE) finalRel = r.to
        } else if (finalRel.startsWith(r.from)) {
          finalRel = r.to + finalRel.slice(r.from.length)
        }
      }
      plan.push({ srcRel: rel, finalRel })
    }
  }

  // 2. 备份（改名已有项）
  const backups = []
  if (backupTargets.length > 0) {
    if (!backupSuffix) throw new Error('backupTargets 需要 backupSuffix')
    const wanted = new Set(backupTargets.map((p) => path.resolve(p)))
    for (const c of conflicts) {
      if (!wanted.has(path.resolve(c.target))) continue
      const to = uniqueBackupPath(c.target, backupSuffix)
      await mkdir(path.dirname(to), { recursive: true })
      await rename(c.target, to)
      backups.push({ from: c.target, to })
    }
  }
  onProgress('backups', backups)

  // 3. 暂存 → 提交 → 失败回滚
  const stageRoot = path.join(targetDir, `.atp-stage-${process.pid}-${Date.now()}`)
  const stashRoot = path.join(stageRoot, '.rollback')
  const committed = []
  const madeDirs = []
  const stashed = []

  const cleanup = async () => {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
  }

  const rollback = async () => {
    for (const f of committed.reverse()) await rm(f, { recursive: true, force: true }).catch(() => {})
    for (const s of stashed.reverse()) {
      await mkdir(path.dirname(s.from), { recursive: true }).catch(() => {})
      await rename(s.to, s.from).catch(() => {})
    }
    for (const b of backups.reverse()) await rename(b.to, b.from).catch(() => {})
    for (const d of madeDirs.reverse()) await rmdir(d).catch(() => {})
    await cleanup()
  }

  try {
    // 3.1 全量写进暂存（用户目录此时未被改动）
    for (const item of plan) {
      const dest = path.join(stageRoot, item.finalRel)
      await mkdir(path.dirname(dest), { recursive: true })
      const srcAbs = path.join(sourceRoot, item.srcRel)
      if (TEXT_RE.test(item.srcRel) && renames.length > 0) {
        await writeFile(dest, rewriteReferences(await readFile(srcAbs, 'utf8'), renames), 'utf8')
      } else {
        await writeFile(dest, await readFile(srcAbs))
      }
    }
    onProgress('staged', plan.length)

    // 3.2 提交前把"我们真要占用但还存在"的原件挪进 stash
    const destSet = new Set(plan.map((i) => path.join(targetDir, i.finalRel)))
    for (const c of conflicts) {
      const target = c.target
      if (!existsSync(target)) continue // 已被备份走
      if (!destSet.has(target)) continue // 我们改了自己的名字，没占用它
      const rel = path.relative(targetDir, target)
      const to = path.join(stashRoot, rel)
      await mkdir(path.dirname(to), { recursive: true })
      await rename(target, to)
      stashed.push({ from: target, to })
    }

    // 3.3 提交
    for (const item of plan) {
      const dest = path.join(targetDir, item.finalRel)
      if (!dest.startsWith(targetDir + path.sep)) throw new Error(`拒绝写入目标目录之外：${dest}`)
      const missing = []
      let dir = path.dirname(dest)
      while (!existsSync(dir)) {
        missing.unshift(dir)
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      for (const d of missing) {
        await mkdir(d)
        madeDirs.push(d)
      }
      await rename(path.join(stageRoot, item.finalRel), dest)
      committed.push(dest)
      // 仅测试用故障注入：验证"中途失败也能完整回滚"
      const failAfter = Number(process.env.ATP_FAIL_AFTER_COMMITS ?? 0)
      if (failAfter > 0 && committed.length === failAfter) {
        throw new Error(`injected failure after ${failAfter} commits`)
      }
    }

    // 3.4 校验：全部落地，且核心与分册都在
    const missingAfter = plan.filter((i) => !existsSync(path.join(targetDir, i.finalRel)))
    if (missingAfter.length > 0) throw new Error(`提交后缺少 ${missingAfter.length} 个文件`)
    const coreFinal = plan.find((i) => i.srcRel === CORE_FILE)?.finalRel
    const sampleDoc = plan.find((i) => i.srcRel.startsWith(`${DOCS_DIR}/workflow/rules/`))?.finalRel
    if (!coreFinal || !sampleDoc || !existsSync(path.join(targetDir, coreFinal)) || !existsSync(path.join(targetDir, sampleDoc))) {
      throw new Error('核心与分册没有同时落地')
    }
  } catch (error) {
    await rollback()
    return { ok: false, code: 'failed', message: error.message, installed: [], backups: [] }
  }

  await cleanup()
  return { ok: true, installed: plan.map((i) => i.finalRel), backups }
}
