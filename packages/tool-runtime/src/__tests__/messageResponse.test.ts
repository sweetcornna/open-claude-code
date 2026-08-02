import { describe, expect, test } from 'bun:test'
import { createElement, isValidElement } from 'react'
import type {
  MessageResponseHost,
  MessageResponseProps,
} from '../messageResponse.js'

async function loadFacade() {
  return import(`../messageResponse.ts?case=${Math.random()}`)
}

describe('MessageResponse facade', () => {
  test('renders children unchanged when no host is registered', async () => {
    const facade = await loadFacade()
    const child = createElement('span', null, 'standalone')

    expect(facade.MessageResponse({ children: child, height: 2 })).toBe(child)
  })

  test('renders the registered host component', async () => {
    const facade = await loadFacade()
    const host: MessageResponseHost = ({ children }) => children
    const child = createElement('span', null, 'delegated')

    facade.registerMessageResponseHost(host)

    const rendered = facade.MessageResponse({ children: child, height: 3 })
    expect(isValidElement<MessageResponseProps>(rendered)).toBe(true)
    if (!isValidElement<MessageResponseProps>(rendered)) {
      throw new Error('Expected the facade to return a React element')
    }
    expect(rendered.type).toBe(host)
    expect(rendered.props).toEqual({ children: child, height: 3 })
  })
})
