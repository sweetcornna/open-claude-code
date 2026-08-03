export const GEMINI_THOUGHT_SIGNATURE_FIELD = '_geminiThoughtSignature'

export type GeminiFunctionCall = {
  name?: string
  args?: Record<string, unknown>
}

export type GeminiFunctionResponse = {
  name?: string
  response?: Record<string, unknown>
}

export type GeminiInlineData = {
  mimeType: string
  data: string
}

export type GeminiPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: GeminiFunctionCall
  functionResponse?: GeminiFunctionResponse
  inlineData?: GeminiInlineData
}

export type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export type GeminiFunctionDeclaration = {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  parametersJsonSchema?: Record<string, unknown>
}

export type GeminiTool = {
  functionDeclarations?: GeminiFunctionDeclaration[]
  /**
   * Google Search grounding — Gemini's server-side search tool. Takes an empty
   * object; results come back in `GeminiCandidate.groundingMetadata` rather
   * than as a function call. Mutually exclusive with functionDeclarations in
   * practice, hence both fields being optional on one type.
   */
  googleSearch?: Record<string, never>
}

export type GeminiFunctionCallingConfig = {
  mode: 'AUTO' | 'ANY' | 'NONE'
  allowedFunctionNames?: string[]
}

export type GeminiGenerateContentRequest = {
  contents: GeminiContent[]
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  tools?: GeminiTool[]
  toolConfig?: {
    functionCallingConfig: GeminiFunctionCallingConfig
  }
  generationConfig?: {
    temperature?: number
    thinkingConfig?: {
      includeThoughts?: boolean
      thinkingBudget?: number
    }
  }
}

export type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
}

/** One retrieved source behind a Google Search grounded answer. */
export type GeminiGroundingChunk = {
  web?: {
    uri?: string
    title?: string
    domain?: string
  }
}

/** Which answer segment each grounding chunk supports. */
export type GeminiGroundingSupport = {
  segment?: {
    startIndex?: number
    endIndex?: number
    text?: string
  }
  groundingChunkIndices?: number[]
}

export type GeminiGroundingMetadata = {
  webSearchQueries?: string[]
  groundingChunks?: GeminiGroundingChunk[]
  groundingSupports?: GeminiGroundingSupport[]
}

export type GeminiCandidate = {
  content?: {
    role?: string
    parts?: GeminiPart[]
  }
  finishReason?: string
  index?: number
  /** Present when the request enabled the `googleSearch` grounding tool. */
  groundingMetadata?: GeminiGroundingMetadata
}

export type GeminiStreamChunk = {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
}
