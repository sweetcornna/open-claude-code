/**
 * Host facade for slow-operation-aware JSON helpers.
 *
 * Tool runtime is a leaf package, so it cannot import the host implementation:
 * that implementation records measurements in host bootstrap state. The host
 * registers its implementation during tool assembly instead. Standalone
 * package use and tests run unregistered; in that case only instrumentation is
 * disabled and the helpers fall back to the equivalent native JSON operation.
 */

type JsonReplacer =
  | ((this: unknown, key: string, value: unknown) => unknown)
  | (number | string)[]
  | null

export interface SlowOperationsHost {
  jsonParse: typeof JSON.parse
  jsonStringify(
    value: unknown,
    replacer?: JsonReplacer,
    space?: string | number,
  ): string
}

let host: SlowOperationsHost | null = null

export function registerSlowOperationsHost(h: SlowOperationsHost): void {
  host = h
}

export const jsonParse: typeof JSON.parse = (text, reviver) => {
  if (host) return host.jsonParse(text, reviver)

  return typeof reviver === 'undefined'
    ? JSON.parse(text)
    : JSON.parse(text, reviver)
}

export function jsonStringify(
  value: unknown,
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?: (number | string)[] | null,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?: JsonReplacer,
  space?: string | number,
): string {
  if (host) return host.jsonStringify(value, replacer, space)

  return JSON.stringify(
    value,
    replacer as Parameters<typeof JSON.stringify>[1],
    space,
  )
}
