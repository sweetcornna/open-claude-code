import { config } from '../config'

function originFromUrl(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).origin
  } catch {
    return undefined
  }
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const { hostname } = new URL(origin)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    )
  } catch {
    return false
  }
}

export function getAllowedWebCorsOrigins(): string[] {
  const origins = new Set<string>(config.webCorsOrigins)

  const baseOrigin = config.baseUrl ? originFromUrl(config.baseUrl) : undefined
  if (baseOrigin) {
    origins.add(baseOrigin)
  }

  // Loopback origins are a development convenience. Granting them credentialed
  // CORS on a production deployment lets any page a victim visits — including
  // one served from their own machine — read the Web UI API with the
  // __Host-rcs_session cookie attached. Keep them only where they are the
  // actual deployment origin.
  if (process.env.NODE_ENV !== 'production' || isLoopbackOrigin(baseOrigin)) {
    origins.add(`http://localhost:${config.port}`)
    origins.add(`http://127.0.0.1:${config.port}`)
  }

  return [...origins]
}

export function resolveWebCorsOrigin(origin: string): string | undefined {
  return getAllowedWebCorsOrigins().includes(origin) ? origin : undefined
}

export const webCorsOptions = {
  origin: resolveWebCorsOrigin,
  allowHeaders: ['Content-Type'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
}
