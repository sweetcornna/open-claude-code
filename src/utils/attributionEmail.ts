const MODEL_EMAIL_MAP: Array<{ keywords: string[]; email: string }> = [
  { keywords: ['claude'], email: 'noreply@anthropic.com' },
  {
    keywords: ['gpt', 'dall-e', 'o1-', 'o3-', 'o4-'],
    email: 'noreply@openai.com',
  },
  { keywords: ['gemini'], email: 'noreply@google.com' },
  { keywords: ['grok'], email: 'noreply@xai.com' },
  { keywords: ['glm'], email: 'noreply@zhipuai.cn' },
  { keywords: ['deepseek'], email: 'noreply@deepseek.com' },
  { keywords: ['qwen'], email: 'noreply@alibabacloud.com' },
]

export function getAttributionEmail(modelName: string): string {
  const lower = modelName.toLowerCase()
  for (const { keywords, email } of MODEL_EMAIL_MAP) {
    if (keywords.some(kw => lower.includes(kw))) {
      return email
    }
  }
  return 'noreply@anthropic.com'
}
