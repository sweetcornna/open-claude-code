/**
 * dump-prompt.ts — 渲染完整 system prompt，用于人工审读格式与内容。
 *
 * 改 prompt 前后各跑一次、diff 两份输出，是这个仓库里唯一能看到「模型实际
 * 收到什么」的手段 —— 单测只断言若干锚点句，看不出段落顺序、空行、以及
 * 被门控掉的整段。
 *
 * Usage: bun run scripts/dump-prompt.ts [model-id]
 */
import {
  setupSystemPromptMocks,
  SYSTEM_PROMPT_MOCK_TOOLS,
} from '../tests/mocks/systemPromptEnv.js'

setupSystemPromptMocks()

const { getSystemPrompt } = await import('src/constants/prompts.js')

const model = process.argv[2] ?? 'claude-opus-5'
const sections = await getSystemPrompt(SYSTEM_PROMPT_MOCK_TOOLS as never, model)
const full = sections.join('\n\n')

const outputPath = 'scripts/system-prompt-dump.txt'
await Bun.write(outputPath, full)

console.log(`Written to ${outputPath}`)
console.log(`Model: ${model}`)
console.log(`Sections: ${sections.length}`)
console.log(`Characters: ${full.length}`)
