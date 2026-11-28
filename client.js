/**
 * dsh-agent-team-playbook — 浏览器半身（Step 1：只读面板）
 *
 * 形态照抄官方内置插件（如 @deepseek-ai/dsh-client-ui-open-in-app）：
 * 手写 window.__ModuleLoader__.load({ id, factory })，无构建步骤，
 * require 由 shell 提供（react / primitives / slots …）。
 *
 * 本步只做**只读**面板：
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
    const API = '/api/agent-team-playbook/status'
    const Button = primitives?.Button

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

    function LinkButton({ onClick, children }) {
      if (typeof Button === 'function') return h(Button, { onClick, variant: 'secondary' }, children)
      return h('button', { type: 'button', onClick }, children)
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
            h('div', { key: 'conf', style: { marginTop: 8, marginBottom: 4, color: 'var(--dsh-warning, #b8862b)' } },
              `检测到 ${conflicts.length} 处同名内容（不会被自动覆盖）：`),
          )
          conflicts.forEach((c, i) => {
            children.push(
              h('div', { key: `c${i}`, style: { paddingLeft: 12, margin: '2px 0' } },
                `${i + 1}. ${c.rel} — ${c.reason}`),
            )
          })
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

      children.push(
        h('div', { key: 'actions', style: { marginTop: 10, display: 'flex', gap: 8 } },
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
      Panel.ctx = ctx
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'agent-team-playbook',
        order: 36,
        label: () => '协作规程',
      }, () => h(Panel, null)))
    }

    exports.apply = apply
    exports.inject = ['slots', 'sessions']
    exports.name = NAME
    return module.exports
  },
})
