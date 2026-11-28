/**
 * dsh-agent-team-playbook — guard half.
 *
 * 本包的主体是一个只读 skill（挂在 skills/agent-team-playbook/），不需要任何代码。
 * 这一半只做一件事：**发现同名 skill 被别人抢走时给出提示**。
 *
 * 为什么需要它：DSH 的 skill 注册表对同名条目不报错，只按 rank 静默择优
 * （见 @deepseek-ai/dsh-skill：「the nearest layer's entry wins a duplicate name
 * outright」）。也就是说，如果用户自己已经有 skills/agent-team-playbook/，
 * 或者另一个插件也提供同名 skill，谁生效是静默发生的，用户无从察觉。
 *
 * 本模块不写用户任何文件、不改任何配置，只读 skill 目录并在需要时打一条 warn。
 *
 * @module lib/index.js
 */

export const name = 'dsh-agent-team-playbook'

/** 本插件提供的 skill 名与 provider 名（与 cordis.patch.yml 保持一致）。 */
const DEFAULT_SKILL_NAME = 'agent-team-playbook'
const OUR_PROVIDER = 'agent-team-playbook'

/** 等所有 provider 注册完、首轮发现跑完再检查；这只是提示，晚一点没有副作用。 */
const CHECK_DELAY_MS = 2500

/**
 * 检查同名 skill 的最终归属；被别的来源抢走时告警。
 * 全程 try/catch：提示失败绝不能影响插件加载。
 */
async function reportShadowing(ctx, skillName) {
  try {
    const skills = ctx.skills
    if (skills === undefined || typeof skills.list !== 'function') return

    const list = await skills.list({})
    if (!Array.isArray(list)) return

    const hit = list.find((entry) => entry && entry.name === skillName)
    if (hit === undefined) return

    // 我们自己的 provider 赢了：正常，不打扰用户。
    if (hit.provider === OUR_PROVIDER) return

    const where = typeof hit.path === 'string' ? `（${hit.path}）` : ''
    ctx.logger.warn(
      `skill "${skillName}" 当前由其他来源提供${where}，本插件的同名 skill 未生效。` +
        '若想用 dsh-agent-team-playbook 的版本，请移走或重命名上述 skill 后重载；' +
        `若本来就想用自己的版本，可忽略本提示。`,
    )
  } catch (error) {
    // 只读检查，失败不抛。
    ctx.logger?.debug?.(`dsh-agent-team-playbook: skill check skipped (${error?.message ?? error})`)
  }
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ skillName?: string } | undefined} config
 */
export function apply(ctx, config) {
  const skillName = config?.skillName ?? DEFAULT_SKILL_NAME

  // skills 服务在部分 composition 里可能不存在；用 inject 等它出现，缺失时不报错。
  ctx.inject(['skills'], (ctx) => {
    const run = () => reportShadowing(ctx, skillName)

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const timer = setTimeout(run, CHECK_DELAY_MS)
        if (typeof timer?.unref === 'function') timer.unref()
        return () => clearTimeout(timer)
      })
    } else {
      const timer = setTimeout(run, CHECK_DELAY_MS)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  })
}
