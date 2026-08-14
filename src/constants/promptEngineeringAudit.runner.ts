/**
 * promptEngineeringAudit.runner.ts — system prompt 护栏
 *
 * 钉住 prompts.ts 的行为/安全锚点句与结构约束。原「Opus 4.7 提示词
 * 工程技巧」的逐字断言（few-shot 示例、工具偏好清单、Linguistic
 * signals 等）已按 Claude 5 上下文工程规则随目标内容一起删除 ——
 * 本文件现在只守三类：保留句锚点、反向回归断言（已删内容不得回归，
 * 防 rebase 带回）、以及产品信息的放宽版存在性断言。
 *
 * 测试策略: 通过 getSystemPrompt() 生成完整 system prompt，
 * 然后检查关键段落是否存在。大部分被测函数是 module-private，
 * 只能通过最终输出间接验证。
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { stateMockWith } from '../../tests/mocks/state.js'
import { setupGrowthbookMock } from '../../tests/mocks/growthbook.js'
import { setupEnvUtilsMock } from '../../tests/mocks/envUtils.js'

// --- MACRO 全局注入 (编译时 define 在测试中不可用) ---
;(globalThis as any).MACRO = {
  VERSION: '2.1.888',
  BUILD_TIME: '2026-04-22T00:00:00Z',
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: 'report issues on GitHub',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: '',
  VERSION_CHANGELOG: '',
}

// --- Mock 链 (阻断副作用) ---

mock.module(
  'src/bootstrap/state.ts',
  stateMockWith({
    getIsNonInteractiveSession: () => false,
    sessionId: 'test-session',
    getCwd: () => '/test/project',
  }),
)
mock.module('src/utils/filesystem/cwd.js', () => ({
  getCwd: () => '/test/project',
}))
mock.module('src/utils/git/git.ts', () => ({
  getIsGit: async () => true,
}))
mock.module('src/utils/git/worktree.js', () => ({
  getCurrentWorktreeSession: () => null,
}))
mock.module('src/constants/common.js', () => ({
  getSessionStartDate: () => '2026-04-22',
}))
const settingsMock = setupSettingsMock({
  getInitialSettings: () => ({ language: undefined }),
})
afterAll(() => settingsMock.reset())

mock.module('src/commands/poor/poorMode.js', () => ({
  isPoorModeActive: () => false,
}))
mock.module('src/utils/config/env.js', () => ({
  env: { platform: 'linux' },
}))
// Shared complete-surface envUtils mock (see tests/mocks/envUtils.ts).
// isEnvTruthy pinned false: the audit needs deterministic prompts regardless
// of whatever env flags the host machine happens to have.
const envUtilsMock = setupEnvUtilsMock({
  isEnvTruthy: () => false,
})
mock.module('src/utils/model/model.js', () => ({
  getCanonicalName: (id: string) => id,
  getMarketingNameForModel: (id: string) => {
    if (id.includes('opus-4-7')) return 'Claude Opus 4.7'
    if (id.includes('opus-4-6')) return 'Claude Opus 4.6'
    if (id.includes('sonnet-4-6')) return 'Claude Sonnet 4.6'
    return null
  },
}))
mock.module('src/commands.js', () => ({
  getSkillToolCommands: async () => [],
}))
mock.module('src/constants/outputStyles.js', () => ({
  getOutputStyleConfig: async () => null,
}))
mock.module('src/utils/tools/embeddedTools.js', () => ({
  hasEmbeddedSearchTools: () => false,
}))
mock.module('src/utils/permissions/filesystem.js', () => ({
  isScratchpadEnabled: () => false,
  getScratchpadDir: () => '/tmp/scratchpad',
}))
// Toggleable so the boundary-position assertion can exercise the
// global-cache-scope path (boundary marker only appears when it's on).
let mockGlobalCacheScope = false
mock.module('src/utils/model/betas.js', () => ({
  shouldUseGlobalCacheScope: () => mockGlobalCacheScope,
}))
const undercoverMock = setupUndercoverMock({
  isUndercover: () => false,
})
afterAll(() => undercoverMock.reset())

mock.module('src/utils/model/antModels.js', () => ({
  getAntModelOverrideConfig: () => null,
}))
mock.module('src/utils/mcp/mcpInstructionsDelta.js', () => ({
  isMcpInstructionsDeltaEnabled: () => false,
}))
mock.module('src/memdir/memdir.js', () => ({
  loadMemoryPrompt: async () => null,
}))
mock.module('src/utils/telemetry/debug.ts', () => ({
  logForDebugging: () => {},
}))
// growthbook goes through the shared complete-surface mock (missing exports
// delegate to the real module) — see tests/mocks/growthbook.ts.
const growthbookMock = setupGrowthbookMock({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
})
mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))
mock.module('src/constants/systemPromptSections.js', () => ({
  systemPromptSection: (_name: string, fn: () => any) => fn(),
  DANGEROUS_uncachedSystemPromptSection: (_name: string, fn: () => any) => fn(),
  resolveSystemPromptSections: async (sections: any[]) =>
    sections.filter(s => s !== null),
}))

// 工具常量 mock
const TOOL_NAMES = {
  Bash: 'Bash',
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Write',
  Glob: 'Glob',
  Grep: 'Grep',
  Agent: 'Agent',
  AskUserQuestion: 'AskUserQuestion',
  TaskCreate: 'TaskCreate',
  DiscoverSkills: 'DiscoverSkills',
  Skill: 'Skill',
}

mock.module(
  '@open-claude-code/builtin-tools/tools/BashTool/toolName.js',
  () => ({ BASH_TOOL_NAME: TOOL_NAMES.Bash }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/FileReadTool/prompt.js',
  () => ({ FILE_READ_TOOL_NAME: TOOL_NAMES.Read }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/FileEditTool/constants.js',
  () => ({ FILE_EDIT_TOOL_NAME: TOOL_NAMES.Edit }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/FileWriteTool/prompt.js',
  () => ({ FILE_WRITE_TOOL_NAME: TOOL_NAMES.Write }),
)
mock.module('@open-claude-code/builtin-tools/tools/GlobTool/prompt.js', () => ({
  GLOB_TOOL_NAME: TOOL_NAMES.Glob,
}))
mock.module('@open-claude-code/builtin-tools/tools/GrepTool/prompt.js', () => ({
  GREP_TOOL_NAME: TOOL_NAMES.Grep,
}))
mock.module(
  '@open-claude-code/builtin-tools/tools/AgentTool/constants.js',
  () => ({
    AGENT_TOOL_NAME: TOOL_NAMES.Agent,
    VERIFICATION_AGENT_TYPE: 'verification',
  }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/AgentTool/forkSubagent.js',
  () => ({ isForkSubagentEnabled: () => false }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/AgentTool/builtInAgents.js',
  () => ({ areExplorePlanAgentsEnabled: () => false }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/AgentTool/built-in/exploreAgent.js',
  () => ({
    EXPLORE_AGENT: { agentType: 'explore' },
    EXPLORE_AGENT_MIN_QUERIES: 5,
  }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/AskUserQuestionTool/prompt.js',
  () => ({ ASK_USER_QUESTION_TOOL_NAME: TOOL_NAMES.AskUserQuestion }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/TodoWriteTool/constants.js',
  () => ({ TODO_WRITE_TOOL_NAME: 'TodoWrite' }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/TaskCreateTool/constants.js',
  () => ({ TASK_CREATE_TOOL_NAME: TOOL_NAMES.TaskCreate }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/DiscoverSkillsTool/prompt.js',
  () => ({ DISCOVER_SKILLS_TOOL_NAME: TOOL_NAMES.DiscoverSkills }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/SkillTool/constants.js',
  () => ({ SKILL_TOOL_NAME: TOOL_NAMES.Skill }),
)
mock.module(
  '@open-claude-code/builtin-tools/tools/REPLTool/replMode.js',
  () => ({
    isReplModeEnabled: () => false,
  }),
)

// --- 导入被测模块 ---

import {
  getSystemPrompt,
  prependBullets,
  computeSimpleEnvInfo,
  getScratchpadInstructions,
  CORE_TOOLS_PROMPT_LEADING_NAMES,
  CORE_TOOLS_PROMPT_TRAILING_NAMES,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from './prompts.js'
import { CORE_TOOLS } from './tools.js'
import type { Tools } from '../Tool.js'
import { setupSettingsMock } from '../../tests/mocks/settings.js'
import { setupUndercoverMock } from '../../tests/mocks/undercover.js'

// --- 辅助 ---

const standardTools: Tools = [
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Edit' },
  { name: 'Write' },
  { name: 'Glob' },
  { name: 'Grep' },
  { name: 'Agent' },
  { name: 'AskUserQuestion' },
  { name: 'TaskCreate' },
] as any

async function getFullPrompt(
  tools: Tools = standardTools,
  model = 'claude-opus-4-7',
): Promise<string> {
  const sections = await getSystemPrompt(tools, model)
  return sections.join('\n\n')
}

// =====================================================================
// 第一部分: 行为锚点（保留句的存在性验证）
// 原 #1-#10「提示词工程技巧验证」已按 Claude 5 上下文工程规则删除 ——
// 它们逐字钉住的 few-shot 示例/工具偏好清单/Linguistic signals 正是
// 瘦身要删的内容。仅保留钉「保留句」的组与行为/安全锚点。
// =====================================================================

describe('Opus 4.7 Prompt Engineering Audit', () => {
  // ------------------------------------------------------------------
  // #5 成本不对称分析 (Asymmetric Cost Analysis)
  // ------------------------------------------------------------------
  describe('#5 Cost asymmetry framing', () => {
    test('prompt has cost asymmetry for actions (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('cost of pausing to confirm is low')
    })
  })

  // ------------------------------------------------------------------
  // #7 反过度解释 (Anti-Over-Explanation)
  // TXT 来源: {sharing_files}, {request_evaluation_checklist}
  // ------------------------------------------------------------------
  describe('#7 Anti-over-explanation', () => {
    test('prompt contains no-machinery-narration rule (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain("Don't narrate internal machinery")
    })

    test('includes anti-postamble guidance', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain("don't restate")
      expect(prompt).toContain('report the outcome')
    })

    test('discourages offering unchosen approach', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('unchosen approach')
    })
  })

  // ------------------------------------------------------------------
  // #9 Prompt 注入防御 (Prompt Injection Defense)
  // TXT 来源: {anthropic_reminders}, {request_evaluation_checklist}
  // ------------------------------------------------------------------
  describe('#9 Prompt injection defense', () => {
    test('prompt warns about prompt injection in tool results (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('prompt injection')
    })

    test('distinguishes file instructions from user instructions', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('not from the user')
    })
  })

  // =====================================================================
  // 第二部分: 行为规则验证
  // 对应审计文档 第二部分 #11-#18
  // =====================================================================

  // ------------------------------------------------------------------
  // #11 格式化纪律 (Formatting Discipline)
  // TXT 来源: {lists_and_bullets}
  // ------------------------------------------------------------------
  describe('#11 Formatting discipline', () => {
    test('prompt contains prose-first guidance (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('prose paragraphs')
    })

    test('discourages over-formatting', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('over-formatting')
      expect(prompt).toContain('simple answers')
    })

    test('bullet points must be 1-2 sentences, not fragments', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('1-2 sentences')
    })
  })

  // ------------------------------------------------------------------
  // #22 先搜再说不知道 (Search Before Saying Unknown)
  // TXT 来源: {tool_discovery}
  // ------------------------------------------------------------------
  describe('#22 Search before saying unknown', () => {
    test('instructs to search before claiming something does not exist', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Search before saying unknown')
    })

    test('core tools are listed as always available', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('call them directly')
    })
  })

  // ------------------------------------------------------------------
  // #12 温暖语气 (Warm Tone)
  // TXT 来源: {tone_and_formatting}
  // ------------------------------------------------------------------
  describe('#12 Warm tone', () => {
    test('avoids negative assumptions about user abilities', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('negative assumptions')
    })

    test('pushback should be constructive', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('constructively')
    })
  })

  // ------------------------------------------------------------------
  // #20 风险感知时说得更少 (Say Less When Risky)
  // TXT 来源: {refusal_handling}
  // ------------------------------------------------------------------
  describe('#20 Say less when risky', () => {
    test('security-sensitive code should say less about details', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('saying less about implementation details')
    })
  })

  // ------------------------------------------------------------------
  // #13 产品线信息 (Product Information)
  // 放宽版：只钉 env section 存在 + 最新模型 ID 存在。逐字钉家族串
  // ("Claude 4.5/4.6/4.7") 会在模型代际更新时误伤，不再断言。
  // ------------------------------------------------------------------
  describe('#13 Product information', () => {
    test('env info contains Claude Code product description', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('Claude Code')
      expect(envInfo).toContain('CLI')
    })

    test('env info contains correct model IDs', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('claude-opus-4-7')
      expect(envInfo).toContain('claude-sonnet-4-6')
      expect(envInfo).toContain('claude-haiku-4-5')
    })
  })

  // ------------------------------------------------------------------
  // #15 对话结束尊重 (Conversation End Respect)
  // TXT 来源: {refusal_handling} line 51
  // ------------------------------------------------------------------
  describe('#15 Conversation end respect', () => {
    test('discourages "anything else?" appendages', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Do not append')
      expect(prompt).toContain('Is there anything else?')
    })
  })

  // ------------------------------------------------------------------
  // #16 每回复最多一个问题 (One Question Per Response)
  // TXT 来源: {tone_and_formatting} line 71
  // ------------------------------------------------------------------
  describe('#16 One question per response', () => {
    test('limits questions per response', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('one question per response')
    })
  })

  // =====================================================================
  // 第三部分: 已存在功能的回归测试
  // 确保现有的从 TXT 对齐的锚点不被破坏
  // =====================================================================

  describe('Existing behavioral anchors (regression)', () => {
    test('default_stance: default to helping', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Default to helping')
      expect(prompt).toContain('concrete, specific risk of serious harm')
    })

    test('anti-collapse: no self-abasement', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('self-abasement')
      expect(prompt).toContain('maintain self-respect')
    })

    test('cutoff silence: do not proactively mention cutoff', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain(
        "Don't proactively mention your knowledge cutoff",
      )
    })

    test('no-machinery-narration: describe in user terms', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain("Don't narrate internal machinery")
      expect(prompt).toContain('describe the action in user terms')
    })

    test('tool_discovery: search before saying unavailable', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('search for it')
      expect(prompt).toContain(
        'Only state something is unavailable after SearchExtraTools returns no match',
      )
    })

    test('false-claims mitigation: report outcomes faithfully', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('report the outcome')
    })

    test('parallel tool calls: permission AND the dependency constraint', async () => {
      // 两半都是锚点。只留许可 → 模型把有依赖的调用也并行发；只留约束 →
      // 读成「禁止并行」，退回逐个 round-trip。上游同一条也是双向写的。
      const prompt = await getFullPrompt()
      expect(prompt).toContain('call multiple tools in a single response')
      expect(prompt).toContain('independent tool calls in parallel')
      expect(prompt).toContain('run them sequentially instead')
    })

    test('git status before anything that can discard uncommitted work', async () => {
      // 这一节其余的逐条举例是有意删掉的（见下面的瘦身反向断言），
      // 但这条不是举例而是一条可执行的前置动作 —— 模型无法从
      // 「小心不可逆操作」推出「先跑 git status 再 stash -u」。
      const prompt = await getFullPrompt()
      expect(prompt).toContain('run `git status` before any command')
      expect(prompt).toContain('`-u` for untracked')
    })

    test('CYBER_RISK_INSTRUCTION: allows security testing', async () => {
      const prompt = await getFullPrompt()
      // TS 允许安全测试 (TXT 完全禁止 — 这是有意的差异)
      expect(prompt).not.toContain(
        'does not write or explain or work on malicious code',
      )
    })
  })

  // =====================================================================
  // 第四部分: prependBullets 工具函数
  // =====================================================================

  describe('prependBullets utility', () => {
    test('flat items get single bullet', () => {
      const result = prependBullets(['A', 'B'])
      expect(result).toEqual([' - A', ' - B'])
    })

    test('nested arrays get double-indented bullets', () => {
      const result = prependBullets(['A', ['sub1', 'sub2'], 'B'])
      expect(result).toEqual([' - A', '  - sub1', '  - sub2', ' - B'])
    })

    test('empty array returns empty', () => {
      expect(prependBullets([])).toEqual([])
    })
  })

  // =====================================================================
  // 第五部分: 环境信息与模型 cutoff
  // =====================================================================

  describe('Knowledge cutoff correctness', () => {
    test('Opus 4.7 cutoff is January 2026', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('January 2026')
    })

    test('Opus 4.6 cutoff is May 2025', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-6')
      expect(envInfo).toContain('May 2025')
    })

    test('Sonnet 4.6 cutoff is August 2025', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-sonnet-4-6')
      expect(envInfo).toContain('August 2025')
    })

    test('Opus 4.7 frontier model name is correct', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('Claude Opus 4.7')
    })
  })

  // =====================================================================
  // 第六部分: 瘦身反向回归断言
  // 这个 fork 长期从上游 rebase/借鉴，被删的逐字 few-shot 正是 rebase 时
  // 最容易被无脑带回的内容 —— 反向断言是唯一的机械防线。每条注明为什么禁。
  // =====================================================================

  describe('Slimming regressions (deleted content must stay deleted)', () => {
    test('dead content: Anthropic-internal Slack channel ID', async () => {
      // 上游死内容：本 fork 无法投递到该内部频道
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain('C07VBSHV7EV')
    })

    test('few-shot: Linguistic signals list', async () => {
      // few-shot 建档/内联信号清单 — interfaces over examples
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain('Linguistic signals')
      expect(prompt).not.toContain('"write a script"')
    })

    test('unique ownership: shell-equivalent teaching lives in BashTool only', async () => {
      // 「Read over cat / Edit over sed」教学唯一归属 BashTool 工具描述，
      // system prompt 不得再枚举 — 指令唯一归属守卫
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain('over cat')
      expect(prompt).not.toContain('over sed')
    })

    test('slogan: measure twice cut once', async () => {
      // 零信息量口号句
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain('measure twice')
    })

    test('counter-instruction: do-not-justify-search tail', async () => {
      // 与「行动前简述意图」构成对冲的尾句
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain("Don't justify why you're searching")
    })
  })

  // =====================================================================
  // 第七部分: 结构断言（替代逐字内容断言）
  // =====================================================================

  describe('Section structure', () => {
    test('six static sections present in stable order', async () => {
      const prompt = await getFullPrompt()
      const titles = [
        '# System',
        '# Doing tasks',
        '# Executing actions with care',
        '# Using your tools',
        '# Communication style',
      ]
      let lastIndex = -1
      for (const title of titles) {
        const index = prompt.indexOf(title)
        expect(index).toBeGreaterThan(lastIndex)
        lastIndex = index
      }
    })

    test('dynamic boundary sits after all static sections (global cache scope)', async () => {
      mockGlobalCacheScope = true
      try {
        const sections = await getSystemPrompt(standardTools, 'claude-opus-4-7')
        const boundaryIndex = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
        expect(boundaryIndex).toBeGreaterThan(-1)
        const staticPrefix = sections.slice(0, boundaryIndex).join('\n\n')
        expect(staticPrefix).toContain('# Using your tools')
        expect(staticPrefix).toContain('# Communication style')
      } finally {
        mockGlobalCacheScope = false
      }
    })

    test('enumerated core tool names are all CORE_TOOLS members', () => {
      // 防止 Using your tools 的枚举清单再次与真源漂移
      for (const name of [
        ...CORE_TOOLS_PROMPT_LEADING_NAMES,
        ...CORE_TOOLS_PROMPT_TRAILING_NAMES,
      ]) {
        expect(CORE_TOOLS.has(name)).toBe(true)
      }
    })
  })
})

// Overrides are installed at load (the module under test is imported below and
// needs them active), so scope them by resetting at the end instead of moving
// them into beforeAll. Without this they stay installed for every later file
// in the shard — mock.module is process-global.
afterAll(() => {
  envUtilsMock.reset()
  growthbookMock.reset()
})
