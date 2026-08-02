/**
 * Host facade for MessageResponse rendering.
 *
 * Tool runtime is a leaf package, so it cannot import the host implementation:
 * that implementation owns the Ink gutter and its private nesting context. The
 * host registers its implementation during tool assembly instead. Standalone
 * package use and tests run unregistered; in that case the facade renders its
 * children unchanged, without gutter decoration.
 */

import { createElement, type ReactNode } from 'react'

export interface MessageResponseProps {
  children: ReactNode
  height?: number
}

export type MessageResponseHost = (props: MessageResponseProps) => ReactNode

let host: MessageResponseHost | null = null

export function registerMessageResponseHost(
  component: MessageResponseHost,
): void {
  host = component
}

export function MessageResponse(props: MessageResponseProps): ReactNode {
  if (!host) return props.children

  return createElement(host, props)
}
