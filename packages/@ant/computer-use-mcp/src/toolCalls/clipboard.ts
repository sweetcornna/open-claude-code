import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
} from '../types.js'
import { errorResult, okJson, okText, requireString } from './core.js'
import type { CuCallToolResult } from './core.js'
import { syncClipboardStash, TIER_ANTI_SUBVERSION } from './inputGates.js'

export async function handleReadClipboard(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.grantFlags.clipboardRead) {
    return errorResult(
      'Clipboard read is not granted. Request `clipboardRead` via request_access.',
      'grant_flag_required',
    )
  }

  // read_clipboard doesn't route through runInputActionGates — sync here so
  // reading after clicking into a click-tier app sees the cleared clipboard
  // (same as what the app's own Paste would see).
  if (subGates.clipboardGuard) {
    const frontmost = await adapter.executor.getFrontmostApp()
    const tierByBundleId = new Map(
      overrides.allowedApps.map(a => [a.bundleId, a.tier] as const),
    )
    const frontmostTier = frontmost
      ? tierByBundleId.get(frontmost.bundleId)
      : undefined
    await syncClipboardStash(adapter, overrides, frontmostTier === 'click')
  }

  // clipboardGuard may have stashed+cleared — read the actual (possibly
  // empty) clipboard. The agent sees what the app would see.
  const text = await adapter.executor.readClipboard()
  return okJson({ text })
}

export async function handleWriteClipboard(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.grantFlags.clipboardWrite) {
    return errorResult(
      'Clipboard write is not granted. Request `clipboardWrite` via request_access.',
      'grant_flag_required',
    )
  }
  const text = requireString(args, 'text')
  if (text instanceof Error) return errorResult(text.message, 'bad_args')

  if (subGates.clipboardGuard) {
    const frontmost = await adapter.executor.getFrontmostApp()
    const tierByBundleId = new Map(
      overrides.allowedApps.map(a => [a.bundleId, a.tier] as const),
    )
    const frontmostTier = frontmost
      ? tierByBundleId.get(frontmost.bundleId)
      : undefined

    // Defense-in-depth for the clipboardGuard bypass: write_clipboard +
    // left_click on a click-tier app's UI Paste button. The re-clear in
    // syncClipboardStash already defeats it (the next action clobbers the
    // write), but rejecting here gives the agent a clear signal instead of
    // silently voiding its write.
    if (frontmost && frontmostTier === 'click') {
      return errorResult(
        `"${frontmost.displayName}" is a tier-"click" app and currently ` +
          `frontmost. write_clipboard is blocked because the next action ` +
          `would clear the clipboard anyway — a UI Paste button in this ` +
          `app cannot be used to inject text. Bring a tier-"full" app ` +
          `forward before writing to the clipboard.` +
          TIER_ANTI_SUBVERSION,
        'tier_insufficient',
      )
    }

    // write_clipboard doesn't route through runInputActionGates — sync here
    // so clicking away from a click-tier app then writing restores the user's
    // stash before the agent's text lands.
    await syncClipboardStash(adapter, overrides, frontmostTier === 'click')
  }

  await adapter.executor.writeClipboard(text)
  return okText('Clipboard written.')
}
