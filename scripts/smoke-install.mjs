#!/usr/bin/env node
/**
 * 安装自检（smoke install）——验证"用户真的能装上、装完真的能用"。
 *
 * 为什么需要它：单测只覆盖源码，`npm pack` 只验证包内容；真正会坏的是
 * 安装链路（registry 解析、bundle patch 激活、engines 校验、bin 可执行）。
 * 这里用一个**干净的 DSH_HOME** 走一遍真实 `dsh plugin add`。
 *
 * 两种模式：
 *   node scripts/smoke-install.mjs                 # 从 npm 装当前 version
 *   node scripts/smoke-install.mjs --pack          # 先 npm pack 本地，再装 tarball
 *   node scripts/smoke-install.mjs --version 1.32.3 # 指定版本
 *   node scripts/smoke-install.mjs --registry https://registry.npmjs.org/
 *
 * 退出码 0 = 全部通过；非 0 = 有检查失败（可直接用于发版前门禁）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const EXPECTED = flag('version', PKG.version)
const REGISTRY = flag('registry', 'https://registry.npmjs.org/')
const USE_PACK = has('pack')

const results = []
const pass = (name, detail = '') => results.push({ name, ok: true, detail })
const fail = (name, detail = '') => results.push({ name, ok: false, detail })

function run(cmd, argv, options = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf8', timeout: 240_000, ...options })
}

function check(name, body) {
  try {
    const detail = body()
    pass(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(name, String(error?.message ?? error).slice(0, 220))
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const home = mkdtempSync(path.join(tmpdir(), 'atp-smoke-'))
const profile = 'smoke'
const profileDir = path.join(home, 'profiles', profile)
const env = { ...process.env, DSH_HOME: home }

console.log(`\n安装自检：${PKG.name}`)
console.log(`  期望版本：${EXPECTED}`)
console.log(`  registry：${REGISTRY}`)
console.log(`  模式：${USE_PACK ? '本地 npm pack → tarball' : 'npm registry'}`)
console.log(`  沙箱：${home}\n`)

let spec = null
try {
  // ── 0. 解析安装目标 ──────────────────────────────────────────────
  if (USE_PACK) {
    check('0. npm pack 本地打包', () => {
      // npm publish 会把 --dry-run 等经 npm_config_* 传给子进程：不清掉的话嵌套 pack 不产出文件
      const cleanEnv = { ...process.env }
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith('npm_lifecycle_')) delete cleanEnv[key]
        if (/^npm_config_(dry[-_]?run|json|silent)$/i.test(key)) delete cleanEnv[key]
      }
      // 先显式同步 playbook，再用 --ignore-scripts 打包：否则 prepack 的进度输出会混进 --json 的 stdout
      const sync = run(process.execPath, ['scripts/sync-playbook.mjs'], { cwd: ROOT, env: cleanEnv })
      assert(sync.status === 0, `playbook 同步失败：${(sync.stderr || sync.stdout || '').trim().slice(0, 160)}`)
      const out = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', home], { cwd: ROOT, env: cleanEnv })
      assert(out.status === 0, `npm pack 失败：${(out.stderr || out.stdout || '').trim().slice(0, 200)}`)
      let parsed
      try {
        parsed = JSON.parse(out.stdout.trim())
      } catch {
        throw new Error(`npm pack 输出无法解析：${out.stdout.trim().slice(0, 160)}`)
      }
      const tgz = Array.isArray(parsed) && parsed[0]?.filename
      assert(typeof tgz === 'string' && tgz.endsWith('.tgz'), `未拿到 tarball 名：${String(tgz)}`)
      spec = path.join(home, tgz)
      assert(existsSync(spec), `tarball 不存在：${spec}`)
      return path.basename(spec)
    })
  } else {
    spec = `${PKG.name}@${EXPECTED}`
  }

  // ── 1. 真实安装 ──────────────────────────────────────────────────
  check('1. dsh plugin add 安装成功', () => {
    assert(spec !== null, '安装目标未就绪')
    const out = run('dsh', ['plugin', '--profile', profile, 'add', spec, '--registry', REGISTRY], { env })
    assert(out.status === 0, `安装失败：${(out.stderr || out.stdout || '').trim().slice(-300)}`)
    return 'pnpm 安装完成'
  })

  const installedDir = path.join(profileDir, 'node_modules', PKG.name)
  const manifestPath = path.join(installedDir, 'package.json')

  // ── 2. 装的版本与声明 ────────────────────────────────────────────
  check(`2. 装到的版本是 ${EXPECTED}`, () => {
    assert(existsSync(manifestPath), 'node_modules 里没有该包')
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert(installed.version === EXPECTED, `实际装上 ${installed.version}`)
    assert(typeof installed.dsh?.bundle?.patch === 'string', '缺少 dsh.bundle.patch')
    assert(typeof installed.dsh?.client?.platform === 'string', '缺少 dsh.client.platform')
    assert(typeof installed.exports?.['./client'] === 'string', '缺少 exports["./client"]')
    assert(typeof installed.engines?.dsh === 'string', '缺少 engines.dsh（DSH 无法判兼容）')
    return `engines.dsh = ${installed.engines.dsh}`
  })

  // ── 3. bundle patch 被激活 ───────────────────────────────────────
  check('3. profile 配置里出现本插件条目', () => {
    const out = run('dsh', ['--profile', profile, '--dump-config'], { env })
    assert(out.status === 0, `dump-config 失败：${(out.stderr || '').trim().slice(0, 160)}`)
    assert(out.stdout.includes(PKG.name), '组合后的配置里没有本插件')
    return 'bundle patch 已生效'
  })

  // ── 4. patch 文件本身可解析且不自相矛盾 ──────────────────────────
  check('4. cordis.patch.yml 与实际命令一致', () => {
    const patchPath = path.join(installedDir, 'cordis.patch.yml')
    assert(existsSync(patchPath), '包内没有 cordis.patch.yml')
    const text = readFileSync(patchPath, 'utf8')
    assert(/insert:/.test(text), 'patch 里没有 insert 段')
    for (const cmd of ['/atp install', '/atp apply']) {
      assert(text.includes(cmd), `patch 注释缺少命令 ${cmd}`)
    }
    assert(!/不写任何文件/.test(text), 'patch 注释仍写着"不写任何文件"（与实际 install/apply 矛盾）')
    return '命令列表与写入边界一致'
  })

  // ── 5. 从装好的包加载 host 半身 ──────────────────────────────────
  check('5. host 半身加载并注册 /atp', () => {
    const probe = path.join(home, 'probe-host.mjs')
    writeFileSync(probe, `
const m = await import(${JSON.stringify(pathToFileURL(path.join(installedDir, 'lib/index.js')).href)})
const regs = []
m.apply({ commands: { register: (d) => regs.push(d) }, logger: { warn() {} }, inject: () => {}, effect: () => {}, get: () => undefined })
const cmd = regs[0]
if (cmd === undefined) throw new Error('没有注册任何命令')
if (cmd.name !== 'atp') throw new Error('命令名不是 atp，而是 ' + cmd.name)
if (typeof cmd.handler !== 'function') throw new Error('命令没有 handler')
console.log(cmd.name + '|' + JSON.stringify(m.inject ?? []))
`)
    const out = run(process.execPath, [probe])
    assert(out.status === 0, `${(out.stderr || '').trim().slice(-200)}`)
    return out.stdout.trim()
  })

  // ── 6. client 半身契约 ───────────────────────────────────────────
  check('6. client 半身可被 ModuleLoader 装配', () => {
    const probe = path.join(home, 'probe-client.mjs')
    writeFileSync(probe, `
let captured = null
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }
await import(${JSON.stringify(pathToFileURL(path.join(installedDir, 'client.js')).href)})
if (captured === null) throw new Error('bundle 没有调用 __ModuleLoader__.load')
if (captured.id !== ${JSON.stringify(PKG.name)}) throw new Error('bundle id 不是包名：' + captured.id)
const React = { createElement: (t, p, ...c) => ({ t, p, c }), useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: (v) => ({ current: v }) }
const mod = captured.factory((n) => ({ react: React, '@deepseek-ai/dsh-client-ui-primitives': {} })[n] ?? {})
if (typeof mod.apply !== 'function') throw new Error('client 没有导出 apply')
const slots = []
mod.apply({ slots: { inject: (n, cb) => cb(), register: (d) => { slots.push(d.name); return () => {} } }, sessions: { list: { getSnapshot: () => ({ byId: {} }) } }, get: () => undefined })
console.log(JSON.stringify({ inject: mod.inject, slots }))
`)
    const out = run(process.execPath, [probe])
    assert(out.status === 0, `${(out.stderr || '').trim().slice(-200)}`)
    const parsed = JSON.parse(out.stdout.trim())
    assert(parsed.slots.includes('settings.section'), '没有注册设置面板')
    assert(parsed.slots.includes('conversation.hero.options'), '没有注册首页入口')
    assert(parsed.slots.includes('shell.overlay'), '没有注册弹窗层')
    return parsed.slots.join(', ')
  })

  // ── 7. CLI 可执行 ────────────────────────────────────────────────
  check('7. bin 可执行（--help）', () => {
    const cliPath = path.join(installedDir, 'bin', 'cli.mjs')
    assert(existsSync(cliPath), '包里没有 bin/cli.mjs')
    const out = run(process.execPath, [cliPath, '--help'])
    assert(out.status === 0, `--help 退出码 ${out.status}`)
    assert(/init/.test(out.stdout), '--help 输出里没有 init')
    return '用法输出正常'
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log('')
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
if (failed.length > 0) {
  console.log('\n安装自检未通过——不要发版。')
  process.exit(1)
}
console.log('\n安装链路正常。')
