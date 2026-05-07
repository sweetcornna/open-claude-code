const MODEL_GITHUB_MAP: Array<{ keywords: string[]; email: string }> = [
  { keywords: ['claude'], email: 'noreply@anthropic.com' },
  // TODO: 待用户确认以下 GitHub 账号映射
  {
    keywords: ['gpt', 'dall-e', 'o1-', 'o3-', 'o4-'],
    email: 'openai@users.noreply.github.com',
  },
  { keywords: ['gemini'], email: 'google-gemini@users.noreply.github.com' },
  { keywords: ['grok'], email: 'xai-org@users.noreply.github.com' },
  { keywords: ['glm'], email: 'zhipuai@users.noreply.github.com' },
  { keywords: ['deepseek'], email: 'deepseek-ai@users.noreply.github.com' },
  { keywords: ['qwen'], email: 'QwenLM@users.noreply.github.com' },
  { keywords: ['minimax'], email: 'MiniMax-AI@users.noreply.github.com' },
  { keywords: ['mimo'], email: 'XiaomiMiMo@users.noreply.github.com' },
  { keywords: ['kimi'], email: 'MoonshotAI@users.noreply.github.com' },
]

export function getAttributionEmail(modelName: string): string {
  const lower = modelName.toLowerCase()
  for (const { keywords, email } of MODEL_GITHUB_MAP) {
    if (keywords.some(kw => lower.includes(kw))) {
      return email
    }
  }
  return 'noreply@anthropic.com'
}
