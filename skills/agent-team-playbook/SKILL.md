---
name: agent-team-playbook
description: 一套给「Lead + 多名 AI 队友」用的多智能体协作工作流：怎么定档（快速/标准/严格）、怎么分工与写范围互斥、怎么写任务书、怎么做审计与问题分级、怎么验收、怎么复盘并把经验固化。当任务需要多个 agent 协作、或需要跨轮次保持一致的流程纪律、或用户提到「多智能体」「agent 团队」「协作规程」「流水线」「审计/复盘制度」时使用。Use when coordinating a team of agents or when the user wants a repeatable engineering workflow (triage tiers, task briefs, audit gates, retro loops) rather than ad-hoc work. 也适用于单 agent 但需要严谨流程（数据/支付/不可逆改动）的场景。
whenToUse: 用户要求组队/多 agent 协作；或强调要流程严谨、要防返工、要有审计与复盘；或要在项目里建立长期遵守的工作约定（AGENTS.md 类）。不要用于一次性脚本或闲聊。
---

# Agent Team Playbook（多智能体协作工作流）

**这是只读参考资料，不要自动把文件复制进用户项目。** 需要落到项目里时，明确告知用户并走
`dsh-agent-team-playbook init`（带冲突询问）或征得同意后再写。

## 先看什么

| 想知道 | 读这里（相对本 skill 目录） |
|---|---|
| 最高原则、铁律、档位速查、索引 | `AGENTS.md`（约 5k 字符，先读这个） |
| 流水线 S0–S6 细节、审计清单、事故善后 | `docs/workflow/rules/03-流水线.md` |
| 修复型任务怎么先查根因 | `docs/workflow/rules/03-流水线.md` 的 S1 调查段 |
| 档位怎么选、时间盒、优先级 | `docs/workflow/rules/02-效率与档位详解.md` |
| 任务书模板 | `docs/workflow/rules/04-任务书模板.md` |
| 任务板与回流子条目 | `docs/workflow/rules/05-任务板.md` |
| 组队、Lead/队友职责、沟通 | `docs/workflow/rules/06-协作细则.md` |
| 反馈三类、度量、复盘 | `docs/workflow/rules/01-总纲细则.md`、`07-用户交互与度量.md` |
| 反模式与速查卡 | `docs/workflow/rules/08-反模式与速查.md` |
| 经验库写法 | `docs/workflow/practices/README.md` |
| 总览图 | `docs/assets/architecture.svg` |

## 最短上手路径

1. **接活先定两件事**：可判真假的验收标准 + 档位（快速 15–30 分钟 / 标准 半天 / 严格 1–2 天每子任务）。
2. **动手前先策划**，方案过四问：可行性、合理性、**完整性**（有没有漏分支/失败路径/回滚）、优越性。
3. **修复型任务先调查根因**再改，不允许"没复现就动手"。
4. **完成 = 实现 + 自检 + 证据**，无证据不算完成。
5. **收尾三问**：哪里最慢？哪里最痛？哪条规则该改？有效经验必须写「已固化到哪」。

## 几条最容易踩的

- **审计要全面系统、不要抽样**，且必须追根因——修完要问「还有没有同类隐藏 bug」。
- **审计发现的问题要分级**（高/中/低）：高的本轮修，中低出轮，回流深度上限 1 层。
- **CI 门禁与真机验证可并行，但判定是 AND**，且必须验同一个版本。
- **长任务挂后台**，不要阻塞与用户的对话。
- **别把"能跑"当完成**：还有合理性、优越性、健壮性、完整性、必要的完善与防御性、用户视角、需求补全。

## 落地到用户项目时

插件安装**不会**写用户任何文件。真要写入：

```bash
npx dsh-agent-team-playbook init          # 交互式，冲突时逐项询问（覆盖/改名/跳过）
npx dsh-agent-team-playbook init --dry-run   # 只看计划，不写
```

- 遇到同名文件/目录会**逐个询问**，不会静默覆盖。
- 选「改名」时，写出的文件里对它的引用会**同步改写**，不会留下断链。
- 非交互环境（CI）默认遇到冲突就中止，需要显式 `--force` 或 `--rename`。
