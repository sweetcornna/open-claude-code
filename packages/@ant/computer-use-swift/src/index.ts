interface DisplayGeometry {
  width: number
  height: number
  scaleFactor: number
  displayId: number
}

interface PrepareDisplayResult {
  activated: string
  hidden: string[]
}

interface AppInfo {
  bundleId: string
  displayName: string
}

interface InstalledApp {
  bundleId: string
  displayName: string
  path: string
  iconDataUrl?: string
}

interface RunningApp {
  bundleId: string
  displayName: string
}

interface ScreenshotResult {
  base64: string
  width: number
  height: number
}

interface ResolvePrepareCaptureResult {
  base64: string
  width: number
  height: number
}

interface WindowDisplayInfo {
  bundleId: string
  displayIds: number[]
}

interface AppsAPI {
  prepareDisplay(
    allowlistBundleIds: string[],
    surrogateHost: string,
    displayId?: number,
  ): Promise<PrepareDisplayResult>
  previewHideSet(
    bundleIds: string[],
    displayId?: number,
  ): Promise<Array<AppInfo>>
  findWindowDisplays(
    bundleIds: string[],
  ): Promise<Array<WindowDisplayInfo>>
  appUnderPoint(
    x: number,
    y: number,
  ): Promise<AppInfo | null>
  listInstalled(): Promise<InstalledApp[]>
  iconDataUrl(path: string): string | null
  listRunning(): RunningApp[]
  open(bundleId: string): Promise<void>
  unhide(bundleIds: string[]): Promise<void>
}

interface DisplayAPI {
  getSize(displayId?: number): DisplayGeometry
  listAll(): DisplayGeometry[]
}

interface ScreenshotAPI {
  captureExcluding(
    allowedBundleIds: string[],
    quality: number,
    targetW: number,
    targetH: number,
    displayId?: number,
  ): Promise<ScreenshotResult>
  captureRegion(
    allowedBundleIds: string[],
    x: number,
    y: number,
    w: number,
    h: number,
    outW: number,
    outH: number,
    quality: number,
    displayId?: number,
  ): Promise<ScreenshotResult>
}

export class ComputerUseAPI {
  declare apps: AppsAPI
  declare display: DisplayAPI
  declare screenshot: ScreenshotAPI

  declare resolvePrepareCapture: (
    allowedBundleIds: string[],
    surrogateHost: string,
    quality: number,
    targetW: number,
    targetH: number,
    displayId?: number,
    autoResolve?: boolean,
    doHide?: boolean,
  ) => Promise<ResolvePrepareCaptureResult>
}
