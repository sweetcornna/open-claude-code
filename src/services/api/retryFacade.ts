import { registerAPIRetryHost } from '@open-claude-code/tool-runtime/apiRetry.js'
import { retryOpenAIRequest } from './openai/retry.js'

registerAPIRetryHost({
  retry: retryOpenAIRequest,
})
