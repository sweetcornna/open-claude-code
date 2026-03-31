interface FrontmostAppInfo {
  bundleId: string
  appName: string
}

export class ComputerUseInputAPI {
  declare moveMouse: (
    x: number,
    y: number,
    animated: boolean,
  ) => Promise<void>

  declare key: (
    key: string,
    action: 'press' | 'release',
  ) => Promise<void>

  declare keys: (parts: string[]) => Promise<void>

  declare mouseLocation: () => Promise<{ x: number; y: number }>

  declare mouseButton: (
    button: 'left' | 'right' | 'middle',
    action: 'click' | 'press' | 'release',
    count?: number,
  ) => Promise<void>

  declare mouseScroll: (
    amount: number,
    direction: 'vertical' | 'horizontal',
  ) => Promise<void>

  declare typeText: (text: string) => Promise<void>

  declare getFrontmostAppInfo: () => FrontmostAppInfo | null

  declare isSupported: true
}

interface ComputerUseInputUnsupported {
  isSupported: false
}

export type ComputerUseInput = ComputerUseInputAPI | ComputerUseInputUnsupported
