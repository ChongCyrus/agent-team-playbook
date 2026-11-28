/**
 * dsh-agent-team-playbook — 浏览器半身（Step 1：只读面板）
 *
 * 形态照抄官方内置插件（如 @deepseek-ai/dsh-client-ui-open-in-app）：
 * 手写 window.__ModuleLoader__.load({ id, factory })，无构建步骤，
 * require 由 shell 提供（react / primitives / slots …）。
 *
 * 两步中的第二步：面板 + 冲突处理弹窗。
 * 弹窗里逐项选择 覆盖 / 备份 / 改名，点"应用"后**通过 official Remote 执行**
 * `remote.commands.execute(sessionId, '/atp apply …')` —— 与手动输入等价、有审计记录，
 * 因此不需要任何自定义写文件接口。
 *
 * 面板本身仍然只读：
 *   · 显示当前工作区是否已安装、有无同名冲突
 *   · 冲突项可一键复制建议命令（真正的写入仍由用户执行 /atp apply，可见可审计）
 * 不做任何写操作，也不直接调用命令。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-team-playbook',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NAME = 'dsh-agent-team-playbook'

    /**
     * chip 样式：数值照抄原生的 `.workspace`（HeroShell 的 workspace chip），
     * 这样和「音乐制作 / 标准模式」在同一行时视觉一致。
     */
    const CHIP_CSS = `
/* heroOptions 原生是 margin-left:auto（靠右）；把我们的入口拉回左对齐，紧跟「标准模式」后面 */
div:has(> .atp-wrap){ margin-left: 0 !important; }
/* 菜单项悬停由 React 状态处理，这里只兜底原生按钮默认样式 */
.agent-team-playbook-menu button{ all: unset; }
`
    const CHIP_STYLE_ID = 'agent-team-playbook/chip.css'

    /** 注入一次样式（幂等）。 */
    function ensureStyle() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector(`style[data-plugin-css="${CHIP_STYLE_ID}"]`) !== null) return
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin-css', CHIP_STYLE_ID)
        tag.textContent = CHIP_CSS
        document.head.appendChild(tag)
      } catch {
        /* 样式注入失败不影响功能 */
      }
    }
    const API = '/api/agent-team-playbook/status'
    const Button = primitives?.Button
    const Modal = primitives?.Modal

    // ── 极简 store：面板与弹窗共享"待处理冲突"状态 ─────────────────────────
    const store = { state: { open: false, cwd: '', sessionId: '', conflicts: [], busy: false, message: '' }, listeners: new Set() }
    const readStore = () => store.state
    const writeStore = (patch) => {
      store.state = { ...store.state, ...patch }
      for (const fn of store.listeners) fn()
    }
    const subscribeStore = (fn) => {
      store.listeners.add(fn)
      return () => store.listeners.delete(fn)
    }
    let autoOpened = ''
    const useStore = () => {
      const [snap, setSnap] = React.useState(readStore)
      React.useEffect(() => subscribeStore(() => setSnap(readStore())), [])
      return snap
    }

    /** 把逐项选择拼成一条 /atp apply 命令（导出给测试）。 */
    function buildApplySpec(choices) {
      const parts = choices.map((c, i) => {
        if (c.action === 'backup') return `${i + 1}=备份`
        if (c.action === 'rename') return `${i + 1}=改名:${c.name}`
        return `${i + 1}=覆盖`
      })
      return `/atp apply ${parts.join(' ')}`
    }

    /** 读一次状态；cwd 为空时只验证连通性。 */
    async function fetchStatus(cwd) {
      const url = cwd ? `${API}?cwd=${encodeURIComponent(cwd)}` : API
      const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    /** 取"当前正在看的会话"的 cwd（客户端 sessions 快照里就有）。 */
    function currentCwd(ctx) {
      try {
        const rows = ctx?.sessions?.list?.getSnapshot?.()?.byId ?? {}
        const list = Object.values(rows)
        const active = list.find((row) => (row?.retainedBy?.mainView ?? 0) > 0) ?? list.find((row) => typeof row?.cwd === 'string')
        return typeof active?.cwd === 'string' ? active.cwd : undefined
      } catch {
        return undefined
      }
    }

    /** 一行小字 + 值。 */
    function Row({ label, children }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'baseline', margin: '2px 0' } },
        h('span', { style: { opacity: 0.65, minWidth: 72 } }, label),
        h('span', null, children),
      )
    }

    /** 文字链式按钮（无边框），hover 出淡底；primary 用主色加粗。 */
    function LinkButton({ onClick, children, primary = false }) {
      const [hover, setHover] = React.useState(false)
      return h('button', {
        type: 'button',
        style: {
          border: 0,
          borderRadius: 6,
          background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))' : 'none',
          color: primary ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-secondary, #98a2b3)',
          font: 'inherit',
          fontSize: 13,
          fontWeight: primary ? 600 : 400,
          padding: '4px 8px',
          cursor: 'pointer',
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick,
      }, children)
    }

    /** 解析"当前会话"的 cwd 与 sessionId（客户端 sessions 快照）。 */
    /** 安全取 remote.commands.execute：声明缺失时返回 undefined 而不是抛错。 */
    function remoteExecute(ctx, sessionId, line) {
      try {
        const remote = ctx?.remote ?? (typeof ctx?.get === 'function' ? ctx.get('remote', false) : undefined)
        const commands = remote?.commands ?? (typeof ctx?.get === 'function' ? ctx.get('remote.commands', false) : undefined)
        if (typeof commands?.execute !== 'function') return Promise.resolve({ ok: false, error: { message: '当前 composition 没有远程命令服务，请改用 /atp apply 命令' } })
        return commands.execute(sessionId, line, [])
      } catch (error) {
        return Promise.resolve({ ok: false, error: { message: String(error?.message ?? error) } })
      }
    }

    function currentSession(ctx) {
      try {
        const rows = ctx?.sessions?.list?.getSnapshot?.()?.byId ?? {}
        const entries = Object.entries(rows)
        const active = entries.find(([, row]) => (row?.retainedBy?.mainView ?? 0) > 0) ?? entries.find(([, row]) => typeof row?.cwd === 'string')
        if (active === undefined) return {}
        const [sessionId, row] = active
        return { sessionId, cwd: typeof row?.cwd === 'string' ? row.cwd : undefined }
      } catch {
        return {}
      }
    }

    /**
     * 共享动作：检测当前工作区 → 有冲突打开弹窗，没有就直接装。
     * 面板按钮与首页 chip 都走这一条路径。
     * @returns {Promise<{started: boolean, conflicts: number, error?: string}>}
     */
    async function detectThenInstall(ctx, onDone) {
      try {
        const { sessionId, cwd } = currentSession(ctx)
        const data = await fetchStatus(cwd)
        const found = data?.conflicts ?? []
        const execute = (sid, line) => remoteExecute(ctx, sid, line)
        if (found.length > 0) {
          writeStore({ open: true, conflicts: found, cwd: cwd ?? '', sessionId: sessionId ?? '', execute, afterApply: onDone })
          return { started: true, conflicts: found.length }
        }
        await execute(sessionId, '/atp install')
        if (typeof onDone === 'function') await onDone()
        return { started: true, conflicts: 0 }
      } catch (error) {
        return { started: false, conflicts: 0, error: String(error?.message ?? error) }
      }
    }

    /**
     * 单个冲突行（紧凑一行）：文件名 + 三个小按钮；改名时就地展开输入。
     */
    function ChoiceRow({ index, conflict, onDecide }) {
      const [renaming, setRenaming] = React.useState(false)
      const [name, setName] = React.useState('')

      const [hoverKey, setHoverKey] = React.useState('')
      const pill = (text, onClick, key) => h('button', {
        key,
        type: 'button',
        style: { ...S.pill, ...(hoverKey === key ? S.pillHover : null) },
        onMouseEnter: () => setHoverKey(key),
        onMouseLeave: () => setHoverKey(''),
        onClick,
      }, text)

      if (renaming) {
        return h('div', { style: { ...S.row, flexWrap: 'wrap' } },
          h('div', { style: { width: '100%', ...S.muted, marginBottom: 4 } },
            `${index + 1}. ${shortName(conflict.rel)} —— 新名字：`),
          h('input', {
            value: name,
            placeholder: 'team-docs 或 AGENTS.team.md',
            onChange: (e) => setName(e.target.value),
            style: { flex: '1 1 120px', minWidth: 0, height: 26, padding: '0 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 },
          }),
          pill('确定', () => {
            const clean = String(name).trim()
            if (clean !== '') onDecide(index, 'rename', clean)
          }, 'ok'),
          pill('取消', () => setRenaming(false), 'no'))
      }

      return h('div', { style: S.row },
        h('div', { style: S.fileName, title: conflict.rel },
          h('span', { style: { opacity: 0.5, marginRight: 6 } }, `${index + 1}.`),
          shortName(conflict.rel)),
        h('div', { style: S.actions },
          pill('覆盖', () => onDecide(index, 'overwrite'), 'ow'),
          h('span', { key: 's1', style: S.sep }, '·'),
          pill('备份', () => onDecide(index, 'backup'), 'bk'),
          h('span', { key: 's2', style: S.sep }, '·'),
          pill('改名', () => setRenaming(true), 'rn')))
    }

    /**
     * 冲突处理面板：限高滚动；点一项即定案、该行消失；全部定案后自动执行。
     */
    function ResolveDialog() {
      const state = useStore()
      const decidedRef = React.useRef(new Map())
      const [decidedCount, setDecidedCount] = React.useState(0)
      const [error, setError] = React.useState('')
      const runningRef = React.useRef(false)

      React.useEffect(() => {
        if (!state.open) return
        decidedRef.current = new Map()
        setDecidedCount(0)
        setError('')
        runningRef.current = false
      }, [state.open, state.conflicts])

      if (!state.open) return null

      const conflicts = state.conflicts ?? []

      const maybeApply = async () => {
        if (runningRef.current) return
        if (decidedRef.current.size < conflicts.length) return
        runningRef.current = true
        try {
          const choices = conflicts.map((c, i) => decidedRef.current.get(i) ?? { action: 'overwrite' })
          const coreName = choices.find((c, i) => c.action === 'rename' && conflicts[i].rel === 'AGENTS.md')?.name
          const docsName = choices.find((c, i) => c.action === 'rename' && conflicts[i].rel !== 'AGENTS.md')?.name
          const normalized = conflicts.map((c, i) => {
            const d = choices[i]
            if (d.action !== 'rename') return d
            return { action: 'rename', name: c.rel === 'AGENTS.md' ? coreName : docsName }
          })
          if (normalized.some((c) => c.action === 'rename' && !String(c.name ?? '').trim())) {
            setError('改名项缺少名字')
            runningRef.current = false
            return
          }
          const line = buildApplySpec(normalized)
          const result = await state.execute(state.sessionId, line)
          if (result && result.ok === false) throw new Error(result?.error?.message ?? '命令执行失败')
          writeStore({ open: false })
          if (typeof state.afterApply === 'function') await state.afterApply()
        } catch (e) {
          setError(String(e?.message ?? e))
          runningRef.current = false
        }
      }

      const decide = (index, action, name) => {
        decidedRef.current.set(index, { action, name })
        setDecidedCount(decidedRef.current.size)
        void maybeApply()
      }

      const decideAll = (action) => {
        conflicts.forEach((_, i) => {
          if (!decidedRef.current.has(i)) decidedRef.current.set(i, { action })
        })
        setDecidedCount(decidedRef.current.size)
        void maybeApply()
      }

      const remaining = conflicts.length - decidedCount
      const rows = conflicts
        .map((conflict, index) => ({ conflict, index }))
        .filter(({ index }) => !decidedRef.current.has(index))
        .map(({ conflict, index }) => h(ChoiceRow, { key: `c${index}`, index, conflict, onDecide: decide }))

      const footer = h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        typeof Button === 'function'
          ? h(Button, { variant: 'outline', onClick: () => writeStore({ open: false }) }, '取消')
          : h('button', { type: 'button', style: S.pill, onClick: () => writeStore({ open: false }) }, '取消'))

      const body = [
        h('div', { key: 'bar', style: S.toolbar },
          h('span', { style: S.muted }, `还剩 ${remaining} 项`),
          h('button', { type: 'button', style: { ...S.pill, color: 'var(--dsw-alias-label-primary, inherit)' }, onClick: () => decideAll('overwrite') }, '全部覆盖'),
          h('button', { type: 'button', style: { ...S.pill, color: 'var(--dsw-alias-label-primary, inherit)' }, onClick: () => decideAll('backup') }, '全部备份')),
        h('div', { key: 'list', style: S.dialogBody },
          rows.length > 0 ? rows : h('div', { style: S.muted }, '已全部决定，正在执行…')),
        error ? h('div', { key: 'err', style: { color: 'var(--dsw-alias-label-danger, #e06c5a)', marginTop: 8, fontSize: 12 } }, error) : null,
        h('div', { key: 'hint', style: { ...S.muted, marginTop: 8, lineHeight: 1.4 } },
          '点一项即定案，全部决定后自动执行一条 /atp apply。'),
      ].filter(Boolean)

      if (typeof Modal !== 'function') {
        return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 2147483001, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          h('div', { style: { background: 'var(--dsw-specific-menu, #1c1c1c)', padding: 14, borderRadius: 12, width: '100%', maxWidth: 460 } }, body, footer))
      }
      return h(Modal, { open: true, onClose: () => writeStore({ open: false }), title: `处理同名内容（${remaining}）`, closeLabel: '取消', footer }, body)
    }

    /** 内联样式汇总（不依赖 <style> 注入，避免被覆盖或未生效）。 */
    const S = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 28, padding: '0 8px',
        border: 0, borderRadius: 'var(--dsw-radius-sm, 8px)', background: 'none',
        color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: 13,
        fontWeight: 500, lineHeight: '20px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      menu: {
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 2147483000,
        minWidth: 196, maxWidth: 280, padding: 4, display: 'flex', flexDirection: 'column', gap: 2,
        borderRadius: 'var(--dsw-radius-md, 10px)',
        boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.32))',
        background: 'var(--dsw-specific-menu, rgba(38,38,38,.99))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(12px))',
        textAlign: 'left',
      },
      menuItem: {
        display: 'block', width: '100%', minHeight: 32, padding: '0 10px', border: 0,
        borderRadius: 'var(--dsw-radius-sm, 8px)', background: 'none', color: 'inherit',
        font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer', lineHeight: '32px',
      },
      menuHint: { padding: '2px 10px 6px', fontSize: 11, opacity: 0.55, lineHeight: 1.4 },
      dialogBody: { maxHeight: 'min(42vh, 340px)', overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 2 },
      toolbar: { display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 8px', flexWrap: 'wrap' },
      row: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
        borderTop: '1px solid rgba(127,127,127,.16)',
      },
      fileName: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 },
      actions: { flex: 'none', display: 'flex', gap: 4 },
      // 极简文字操作：默认只是灰色小字，悬停才出淡底（无边框、无灰块）
      pill: {
        minHeight: 22, padding: '0 6px', borderRadius: 6, border: 0, background: 'none',
        color: 'var(--dsw-alias-label-secondary, #98a2b3)', font: 'inherit', fontSize: 12,
        cursor: 'pointer', lineHeight: '22px', whiteSpace: 'nowrap',
      },
      pillHover: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))', color: 'var(--dsw-alias-label-primary, inherit)' },
      sep: { opacity: 0.28, fontSize: 12, userSelect: 'none' },
      muted: { fontSize: 12, opacity: 0.6 },
    }

    /** 路径只显示文件名，完整路径放 title，行高才压得住。 */
    function shortName(rel) {
      const parts = String(rel).split('/')
      return parts[parts.length - 1]
    }

    /**
     * 首页 chip + 下拉菜单（内联样式，确保生效）。
     */
    function HeroEntry() {
      const [badge, setBadge] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [hover, setHover] = React.useState('')
      const wrapRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const { cwd } = currentSession(HeroEntry.ctx)
            const data = await fetchStatus(cwd)
            const n = data?.conflicts?.length ?? 0
            if (alive && n > 0) setBadge(` · ${n}`)
          } catch {
            /* 静默 */
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      React.useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          const node = wrapRef.current
          if (node !== null && node.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [open])

      const run = async (fn) => {
        setOpen(false)
        if (busy) return
        setBusy(true)
        try {
          await fn()
        } finally {
          setBusy(false)
        }
      }

      const items = [
        { key: 'install', label: '安装到工作区', onSelect: () => detectThenInstall(HeroEntry.ctx, undefined) },
        {
          key: 'force',
          label: '覆盖式安装',
          onSelect: async () => {
            const { sessionId } = currentSession(HeroEntry.ctx)
            await remoteExecute(HeroEntry.ctx, sessionId, '/atp install force')
          },
        },
        { key: 'check', label: '检查冲突…', onSelect: () => detectThenInstall(HeroEntry.ctx, undefined) },
        {
          key: 'copy',
          label: '复制 /atp install',
          onSelect: async () => {
            try {
              await navigator.clipboard.writeText('/atp install')
            } catch {
              /* 剪贴板不可用时忽略 */
            }
          },
        },
      ]

      const Icon = primitives?.IconChecklistOutlineRegular
      const label = busy ? '协作规程…' : `协作规程${badge}`

      return h('div', { style: S.wrap, ref: wrapRef },
        h('button', {
          type: 'button',
          style: { ...S.chip, background: open ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))' : 'none' },
          disabled: busy,
          'aria-label': '多智能体协作规程',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        },
        Icon !== undefined ? h(Icon, { size: 16, style: { flex: 'none' } }) : null,
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        h('span', { style: { fontSize: 10, opacity: 0.7 } }, '▾')),

        open
          ? h('div', { style: S.menu, role: 'menu' },
              ...items.map((item) =>
                h('button', {
                  key: item.key,
                  type: 'button',
                  role: 'menuitem',
                  style: { ...S.menuItem, background: hover === item.key ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))' : 'none' },
                  onMouseEnter: () => setHover(item.key),
                  onMouseLeave: () => setHover(''),
                  onClick: () => void run(item.onSelect),
                }, item.label)),
              h('div', { style: S.menuHint }, '覆盖式安装会先把原件暂存，失败可回滚'))
          : null)
    }

    function Panel() {
      const [state, setState] = useState({ phase: 'loading' })
      const [copied, setCopied] = useState('')

      const refresh = useCallback(async () => {
        setState({ phase: 'loading' })
        try {
          const cwd = currentCwd(Panel.ctx)
          const data = await fetchStatus(cwd)
          setState({ phase: 'ready', data, cwd })
        } catch (error) {
          setState({ phase: 'error', message: String(error?.message ?? error) })
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      // 首次进入且已有冲突 → 自动弹一次；同一组冲突只自动弹一次
      useEffect(() => {
        if (state.phase !== 'ready') return
        const found = state.data?.conflicts ?? []
        if (found.length === 0) return
        const fingerprint = `${state.cwd ?? ''}|${found.map((c) => c.rel).join(',')}`
        if (autoOpened === fingerprint) return
        autoOpened = fingerprint
        const ctx = Panel.ctx
        const { sessionId, cwd } = currentSession(ctx)
        const execute = async (sid, line) => remoteExecute(ctx, sid, line)
        writeStore({ open: true, conflicts: found, cwd: cwd ?? '', sessionId: sessionId ?? '', execute, afterApply: refresh })
      }, [state, refresh])

      const conflicts = state.phase === 'ready' ? state.data?.conflicts ?? [] : []

      const suggestion = useMemo(() => {
        if (conflicts.length === 0) return ''
        return `/atp apply ${conflicts.map((_, i) => `${i + 1}=覆盖`).join(' ')}`
      }, [conflicts])

      const copy = useCallback(async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(text)
          setTimeout(() => setCopied(''), 1500)
        } catch {
          setCopied('')
        }
      }, [])

      const children = []
      children.push(h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 4 } }, '多智能体协作规程（agent-team-playbook）'))

      if (state.phase === 'loading') {
        children.push(h(Row, { key: 'loading', label: '状态' }, '检测中…'))
      } else if (state.phase === 'error') {
        children.push(h(Row, { key: 'err', label: '状态' }, `无法连接：${state.message}`))
      } else {
        const d = state.data ?? {}
        children.push(h(Row, { key: 'conn', label: '接口' }, d.connected ? '已连通' : '未连通'))
        children.push(h(Row, { key: 'cwd', label: '工作区' }, d.cwd ?? '（未取到当前会话目录）'))
        children.push(
          h(Row, { key: 'inst', label: '安装状态' }, d.installed ? '已安装（AGENTS.md + docs/ 都在）' : '未安装'),
        )
        if (conflicts.length > 0) {
          children.push(
            h('div', { key: 'conf', style: { marginTop: 8, marginBottom: 4, color: 'var(--dsw-alias-label-warning, #b8862b)' } },
              `${conflicts.length} 处同名内容（不会被自动覆盖）`),
          )
          // 只列前 5 条，其余收进一行，避免面板被长列表撑开
          children.push(...conflicts.slice(0, 5).map((c, i) =>
            h('div', { key: `c${i}`, style: { paddingLeft: 4, margin: '1px 0', ...S.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: c.rel },
              `${i + 1}. ${shortName(c.rel)}`)))
          if (conflicts.length > 5) {
            children.push(h('div', { key: 'more', style: { paddingLeft: 4, ...S.muted } }, `…另有 ${conflicts.length - 5} 项，点「逐项处理冲突…」查看全部`))
          }
          children.push(
            h('div', { key: 'resolve', style: { marginTop: 8 } },
              typeof Button === 'function'
                ? h(Button, {
                    variant: 'primary',
                    onClick: () => {
                      const ctx = Panel.ctx
                      const { sessionId, cwd } = currentSession(ctx)
                      const execute = async (sid, line) => remoteExecute(ctx, sid, line)
                      writeStore({ open: true, conflicts, cwd: cwd ?? '', sessionId: sessionId ?? '', execute, afterApply: refresh })
                    },
                  }, '逐项处理冲突…')
                : null),
          )
          children.push(
            h('div', { key: 'sug', style: { marginTop: 8 } },
              h('div', { style: { opacity: 0.65, marginBottom: 4 } }, '逐项决定后执行（可改 覆盖→备份 / 改名:新名）：'),
              h('code', { style: { display: 'block', padding: 6, borderRadius: 6, background: 'rgba(127,127,127,0.12)' } }, suggestion),
              h('div', { style: { marginTop: 6 } },
                h(LinkButton, { onClick: () => void copy(suggestion) }, copied === suggestion ? '已复制 ✓' : '复制命令')),
            ),
          )
        } else if (d.installed) {
          children.push(h('div', { key: 'ok', style: { marginTop: 8, opacity: 0.8 } }, '没有同名冲突。'))
        }
      }

      // 安装：无冲突直接装；有冲突**直接弹窗**（等价于"install 后自动弹 UI"）
      const install = useCallback(async () => {
        const result = await detectThenInstall(Panel.ctx, refresh)
        if (!result.started && result.error) setState({ phase: 'error', message: result.error })
      }, [refresh])

      children.push(
        h('div', { key: 'actions', style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(LinkButton, { onClick: () => void install(), primary: true }, '安装到工作区'),
          h(LinkButton, { onClick: () => void refresh() }, '重新检测'),
          h(LinkButton, { onClick: () => void copy('/atp install') }, copied === '/atp install' ? '已复制 ✓' : '复制 /atp install')),
      )

      children.push(
        h('div', { key: 'hint', style: { marginTop: 10, opacity: 0.6, fontSize: 12 } },
          '面板只读：不会修改你的文件。安装/覆盖/改名仍通过 /atp install 与 /atp apply 执行（可见、可审计）。'),
      )

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, children)
    }

    function apply(ctx) {
      ensureStyle()
      Panel.ctx = ctx
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'agent-team-playbook',
        order: 36,
        label: () => '协作规程',
      }, () => h(Panel, null)))

      // 首页 chip 行入口：和「音乐制作 / 标准模式」并排
      HeroEntry.ctx = ctx
      ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'agent-team-playbook.entry',
        order: 20,
        label: () => '协作规程',
      }, () => h(HeroEntry, null)))

      // 冲突处理弹窗：常驻挂载，关闭时渲染 null
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agent-team-playbook.resolve',
      }, () => h(ResolveDialog, null)))
    }

    exports.apply = apply
    exports.inject = ['slots', 'sessions', 'remote', 'remote.commands']
    exports.name = NAME
    // 测试缝：拼命令是纯函数，单独可测
    exports.__test = { buildApplySpec, detectThenInstall, ResolveDialog, ChoiceRow, readStore }
    return module.exports
  },
})
