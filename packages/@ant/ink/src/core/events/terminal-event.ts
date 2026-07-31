import { Event } from './event.js'

type EventPhase = 'none' | 'capturing' | 'at_target' | 'bubbling'

type TerminalEventInit = {
  bubbles?: boolean
  cancelable?: boolean
}

/**
 * Base class for all terminal events with DOM-style propagation.
 *
 * Extends Event so existing event types (ClickEvent, InputEvent,
 * TerminalFocusEvent) share a common ancestor and can migrate later.
 *
 * Mirrors the browser's Event API: target, currentTarget, eventPhase,
 * stopPropagation(), preventDefault(), timeStamp.
 */
export class TerminalEvent extends Event {
  readonly type: string
  readonly timeStamp: number
  readonly bubbles: boolean
  readonly cancelable: boolean

  private _target: EventTarget | null = null
  private _currentTarget: EventTarget | null = null
  private _eventPhase: EventPhase = 'none'
  private _propagationStopped = false
  private _defaultPrevented = false

  constructor(type: string, init?: TerminalEventInit) {
    super()
    this.type = type
    this.timeStamp = performance.now()
    this.bubbles = init?.bubbles ?? true
    this.cancelable = init?.cancelable ?? true
  }

  get target(): EventTarget | null {
    return this._target
  }

  get currentTarget(): EventTarget | null {
    return this._currentTarget
  }

  get eventPhase(): EventPhase {
    return this._eventPhase
  }

  get defaultPrevented(): boolean {
    return this._defaultPrevented
  }

  stopPropagation(): void {
    this._propagationStopped = true
  }

  override stopImmediatePropagation(): void {
    super.stopImmediatePropagation()
    this._propagationStopped = true
  }

  preventDefault(): void {
    if (this.cancelable) {
      this._defaultPrevented = true
    }
  }

  // -- Internal setters used by the Dispatcher

  /** @internal */
  _setTarget(target: EventTarget): void {
    this._target = target
  }

  /** @internal */
  _setCurrentTarget(target: EventTarget | null): void {
    this._currentTarget = target
  }

  /** @internal */
  _setEventPhase(phase: EventPhase): void {
    this._eventPhase = phase
  }

  /** @internal */
  _isPropagationStopped(): boolean {
    return this._propagationStopped
  }

  /** @internal */
  _isImmediatePropagationStopped(): boolean {
    return this.didStopImmediatePropagation()
  }

  /**
   * Hook for subclasses to do per-node setup before each handler fires.
   * Default is a no-op.
   */
  _prepareForTarget(_target: EventTarget): void {}
}

/**
 * 终端事件系统的目标节点（DOM 树节点或根节点）。
 *
 * `_eventHandlers` 在这里刻意不写精确类型：精确形状是
 * `Partial<EventHandlerProps>`（event-handlers.ts），但那个模块要引用
 * FocusEvent / KeyboardEvent 等事件类，而它们又继承本文件的 TerminalEvent
 * —— 在此 import 回去就闭成一个环。精确声明在 dom-types.ts 的 DOMElement
 * 上；dispatcher 用 HANDLER_FOR_EVENT 取到键名后再窄化。
 */
export type EventTarget = {
  parentNode: EventTarget | undefined // 父节点，根节点为 undefined
  _eventHandlers?: Record<string, unknown> // 事件处理器，与 dom-types.ts DOMElement 同构
}
