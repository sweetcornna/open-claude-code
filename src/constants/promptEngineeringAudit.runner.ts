/**
 * promptEngineeringAudit.runner.ts — system prompt 护栏
 *
 * 三类断言，各有各的失效模式：
 *
 * 1. **保留句锚点** —— 删掉会改变模型行为的句子。锚点取「操作性最强的那半
 *    句」，不取整段，否则一次措辞润色就红一片。
 * 2. **反向回归** —— 已删内容不得回归。这个 fork 长期从上游 rebase，被删的
 *    逐字 few-shot 与 Anthropic 专属产品线正是最容易被无脑带回的东西，反向
 *    断言是唯一的机械防线。每条注明为什么禁。
 * 3. **结构断言** —— 段落顺序与静态/动态缓存边界的位置。
 *
 * 逐字钉整段是有意避免的：那会把「护栏」变成「快照」，而快照对 prompt 只会
 * 制造噪音。要看完整渲染结果用 `bun run scripts/dump-prompt.ts`，它与本文件
 * 共用同一套 mock（tests/mocks/systemPromptEnv.ts）。
 *
 * 直接 `bun test` 本文件即可；`__tests__/promptEngineeringAudit.test.ts` 是
 * 子进程包装器，防止这里的 mock 泄漏进同分片的其他文件。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  setupSystemPromptMocks,
  SYSTEM_PROMPT_MOCK_TOOLS,
} from '../../tests/mocks/systemPromptEnv.js'

const promptMocks = setupSystemPromptMocks()
afterAll(() => promptMocks.reset())

import {
  getSystemPrompt,
  prependBullets,
  computeSimpleEnvInfo,
  CORE_TOOLS_PROMPT_LEADING_NAMES,
  CORE_TOOLS_PROMPT_TRAILING_NAMES,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from './prompts.js'
import { CORE_TOOLS } from './tools.js'
import type { Tools } from '../Tool.js'

const standardTools = SYSTEM_PROMPT_MOCK_TOOLS as unknown as Tools

async function getFullPrompt(
  tools: Tools = standardTools,
  model = 'claude-opus-5',
): Promise<string> {
  const sections = await getSystemPrompt(tools, model)
  return sections.join('\n\n')
}

describe('System prompt guardrails', () => {
  // ==================================================================
  // 1. 保留句锚点
  // ==================================================================

  describe('Safety and honesty anchors', () => {
    test('actions section keeps the cost-asymmetry framing', async () => {
      expect(await getFullPrompt()).toContain(
        'cost of pausing to confirm is low',
      )
    })

    test('git status before anything that can discard uncommitted work', async () => {
      // 这一节其余的逐条举例是有意删掉的（见反向断言），但这条不是举例而是
      // 一条可执行的前置动作 —— 模型无法从「小心不可逆操作」推出「先跑
      // git status 再 stash -u」。
      const prompt = await getFullPrompt()
      expect(prompt).toContain('run `git status` before any command')
      expect(prompt).toContain('`-u` for untracked')
    })

    test('prefers a reversible step over deleting', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('prefer a reversible step')
      expect(prompt).toContain('are yours to clean up freely')
    })

    test('prompt injection defence distinguishes file text from user instructions', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('prompt injection')
      expect(prompt).toContain('not from the user')
    })

    test('default stance is to help', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Default to helping')
      expect(prompt).toContain('concrete, specific risk of serious harm')
    })

    test('says less about implementation details in security-sensitive code', async () => {
      expect(await getFullPrompt()).toContain(
        'saying less about implementation details',
      )
    })

    test('CYBER_RISK_INSTRUCTION allows authorized security testing', async () => {
      // occ 允许安全测试，与上游 TXT 的完全禁止是有意的差异
      expect(await getFullPrompt()).not.toContain(
        'does not write or explain or work on malicious code',
      )
    })

    test('reports outcomes faithfully without manufacturing green results', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Report outcomes faithfully')
      expect(prompt).toContain('manufacture a green result')
    })

    test('holds position under repeated pushback', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('stay steady and honest')
      expect(prompt).toContain("Don't abandon a correct position")
    })
  })

  describe('Newly ported conduct sections', () => {
    // 这四段是 2026-08 从上游同步进来的，occ 去掉了它们的 Anthropic A/B 门控
    // 改为无条件生效。断言存在性 = 防止有人「顺手」把门控加回来。
    test('delivering work: scope is the deliverable', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('# Delivering work')
      expect(prompt).toContain("don't quietly narrow, widen, or transform it")
      expect(prompt).toContain('report completion only when fully done')
    })

    test('delivering work: reaffirmation is the user decision', async () => {
      expect(await getFullPrompt()).toContain(
        'move on without moralizing or criticism',
      )
    })

    test('corrections: only when it changes the user outcome', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('# Corrections')
      expect(prompt).toContain(
        "change the user's code, conclusions, or decisions",
      )
    })

    test('context management: no early wrap-up', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('# Context management')
      expect(prompt).toContain("you don't need to wrap up early")
    })

    test('act, do not re-derive', async () => {
      expect(await getFullPrompt()).toContain(
        'When you have enough information to act, act.',
      )
    })

    test('task continuity: approval covers the task end to end', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('the approval covers it end to end')
      expect(prompt).toContain('Hand back only when done')
    })

    test('pronoun default is they/them', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('use they/them')
      expect(prompt).toContain('Never infer pronouns from a name')
    })
  })

  describe('Communication anchors', () => {
    test('leads with the outcome', async () => {
      expect(await getFullPrompt()).toContain('Lead with the outcome')
    })

    test('readable beats concise', async () => {
      expect(await getFullPrompt()).toContain(
        'Being readable and being concise are different things',
      )
    })

    test('no machinery narration', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain("Don't narrate internal machinery")
      expect(prompt).toContain('describe the action in user terms')
    })

    test('simple questions get prose, not structure', async () => {
      expect(await getFullPrompt()).toContain(
        'not headers, sections, or bullet lists',
      )
    })

    test('no postamble', async () => {
      expect(await getFullPrompt()).toContain(
        'don\'t append "Is there anything else?"',
      )
    })

    test('at most one question per response', async () => {
      expect(await getFullPrompt()).toContain('one question per response')
    })

    test('pushback stays constructive', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('negative assumptions')
      expect(prompt).toContain('offer an alternative')
    })

    test('does not volunteer the knowledge cutoff', async () => {
      expect(await getFullPrompt()).toContain(
        "Don't proactively mention your knowledge cutoff",
      )
    })
  })

  describe('Tool guidance anchors', () => {
    test('search before saying unknown', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Search before saying unknown')
      expect(prompt).toContain('call them directly')
    })

    test('deferred tools: search before declaring unavailable', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('search for it')
      expect(prompt).toContain(
        'Only state something is unavailable after SearchExtraTools returns no match',
      )
    })

    test('parallel tool calls: permission AND the dependency constraint', async () => {
      // 两半都是锚点。只留许可 → 模型把有依赖的调用也并行发；只留约束 →
      // 读成「禁止并行」，退回逐个 round-trip。
      const prompt = await getFullPrompt()
      expect(prompt).toContain('call multiple tools in a single response')
      expect(prompt).toContain('independent tool calls in parallel')
      expect(prompt).toContain('run them sequentially instead')
    })

    test('enumerated core tool names are all CORE_TOOLS members', () => {
      for (const name of [
        ...CORE_TOOLS_PROMPT_LEADING_NAMES,
        ...CORE_TOOLS_PROMPT_TRAILING_NAMES,
      ]) {
        expect(CORE_TOOLS.has(name)).toBe(true)
      }
    })
  })

  // ==================================================================
  // 2. 反向回归 —— 已删内容不得回归
  // ==================================================================

  describe('Deleted content must stay deleted', () => {
    test('dead content: Anthropic-internal Slack channel ID', async () => {
      // 本 fork 无法投递到该内部频道
      expect(await getFullPrompt()).not.toContain('C07VBSHV7EV')
    })

    test('few-shot: Linguistic signals list', async () => {
      // few-shot 建档/内联信号清单 —— interfaces over examples
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain('Linguistic signals')
      expect(prompt).not.toContain('"write a script"')
    })

    test('unique ownership: shell-equivalent teaching lives in BashTool only', async () => {
      // 「Read over cat / Edit over sed」教学唯一归属 BashTool 工具描述
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain('over cat')
      expect(prompt).not.toContain('over sed')
    })

    test('slogan: measure twice cut once', async () => {
      expect(await getFullPrompt()).not.toContain('measure twice')
    })

    test('counter-instruction: do-not-justify-search tail', async () => {
      // 与「行动前简述意图」构成对冲的尾句
      expect(await getFullPrompt()).not.toContain(
        "Don't justify why you're searching",
      )
    })

    test('Anthropic product lineup occ does not ship', async () => {
      // occ 没有桌面端/网页端/浏览器插件。上游那句在这个构建里是假话，
      // rebase 带回来等于告诉模型一堆不存在的入口。
      const prompt = await getFullPrompt()
      expect(prompt).not.toContain('claude.ai/code')
      expect(prompt).not.toContain('desktop app')
      expect(prompt).not.toContain('Claude in Chrome')
    })

    test('ant-only model override suffix', async () => {
      // USER_TYPE==='ant' 分支在 occ 里恒假，整条链已删
      expect(await getFullPrompt()).not.toContain('defaultSystemPromptSuffix')
    })
  })

  // ==================================================================
  // 3. 结构断言
  // ==================================================================

  describe('Section structure', () => {
    test('static sections appear in a stable order', async () => {
      const prompt = await getFullPrompt()
      const titles = [
        '# System',
        '# Doing tasks',
        '# Executing actions with care',
        '# Using your tools',
        '# Communicating with the user',
        '# Delivering work',
        '# Corrections',
        '# Context management',
      ]
      let lastIndex = -1
      for (const title of titles) {
        const index = prompt.indexOf(title)
        expect(index).toBeGreaterThan(lastIndex)
        lastIndex = index
      }
    })

    test('everything before the dynamic boundary is build-constant', async () => {
      promptMocks.setGlobalCacheScope(true)
      try {
        const sections = await getSystemPrompt(standardTools, 'claude-opus-5')
        const boundaryIndex = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
        expect(boundaryIndex).toBeGreaterThan(-1)
        const staticPrefix = sections.slice(0, boundaryIndex).join('\n\n')
        expect(staticPrefix).toContain('# Using your tools')
        expect(staticPrefix).toContain('# Communicating with the user')
        expect(staticPrefix).toContain('# Delivering work')
        // 会话相关的段落必须在边界之后，否则会把跨组织缓存前缀打碎
        expect(staticPrefix).not.toContain('# Session-specific guidance')
        expect(staticPrefix).not.toContain('# Environment')
      } finally {
        promptMocks.setGlobalCacheScope(false)
      }
    })

    test('feedback line is not truncated', async () => {
      // MACRO.ISSUES_EXPLAINER 曾是空串，于是这行渲染成半句话
      // "To give feedback, users should "。
      expect(await getFullPrompt()).not.toMatch(/users should\s*\n/)
    })
  })

  // ==================================================================
  // 环境段：provider 中立性
  // ==================================================================

  describe('Environment section', () => {
    test('Anthropic sessions get the model catalog', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-5')
      expect(envInfo).toContain('claude-opus-5')
      expect(envInfo).toContain('claude-sonnet-5')
      expect(envInfo).toContain('claude-fable-5')
      expect(envInfo).toContain('claude-haiku-4-5')
    })

    test('non-Anthropic sessions get no Claude model IDs', async () => {
      // 这些 id 在第三方端点上解析成字面量、必然 404。把它们发给
      // OpenAI/Gemini 会话等于让模型把不存在的 API 串写进用户代码。
      promptMocks.setServesAnthropicModels(false)
      try {
        const envInfo = await computeSimpleEnvInfo('gpt-5.4')
        expect(envInfo).not.toContain('claude-opus-5')
        expect(envInfo).not.toContain('default to the latest and most capable')
        expect(envInfo).not.toContain('/fast')
      } finally {
        promptMocks.setServesAnthropicModels(true)
      }
    })

    test('subagents get no product info', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-5', undefined, {
        includeProductInfo: false,
      })
      expect(envInfo).toContain('Primary working directory')
      expect(envInfo).not.toContain('claude-sonnet-5')
      expect(envInfo).not.toContain('/fast')
    })

    test('knowledge cutoffs', async () => {
      expect(await computeSimpleEnvInfo('claude-opus-5')).toContain('May 2026')
      expect(await computeSimpleEnvInfo('claude-opus-4-7')).toContain(
        'January 2026',
      )
      expect(await computeSimpleEnvInfo('claude-sonnet-4-6')).toContain(
        'August 2025',
      )
      expect(await computeSimpleEnvInfo('claude-opus-4-6')).toContain(
        'May 2025',
      )
    })
  })

  describe('prependBullets', () => {
    test('flat items get single bullet', () => {
      expect(prependBullets(['A', 'B'])).toEqual([' - A', ' - B'])
    })

    test('nested arrays get double-indented bullets', () => {
      expect(prependBullets(['A', ['sub1', 'sub2'], 'B'])).toEqual([
        ' - A',
        '  - sub1',
        '  - sub2',
        ' - B',
      ])
    })

    test('empty array returns empty', () => {
      expect(prependBullets([])).toEqual([])
    })
  })
})
