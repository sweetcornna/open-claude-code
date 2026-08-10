export type APIRetryOptions = {
  signal: AbortSignal
  maxRetries?: number
}

export interface APIRetryHost {
  retry<T>(
    operation: (attempt: number) => Promise<T>,
    options: APIRetryOptions,
  ): Promise<T>
}

let host: APIRetryHost | null = null

export function registerAPIRetryHost(nextHost: APIRetryHost | null): void {
  host = nextHost
}

export function retryAPIRequest<T>(
  operation: (attempt: number) => Promise<T>,
  options: APIRetryOptions,
): Promise<T> {
  return host ? host.retry(operation, options) : operation(0)
}
