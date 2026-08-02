import { feature } from 'bun:bundle';
import * as React from 'react';
import type { AutoUpdaterResult } from '../utils/update/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config/config.js';
import { logForDebugging } from '../utils/telemetry/debug.js';
import { getCurrentInstallationType } from '../utils/doctorDiagnostic.js';
import { AutoUpdater } from './AutoUpdater.js';
import { PackageManagerAutoUpdater } from './PackageManagerAutoUpdater.js';

type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};

export function AutoUpdaterWrapper({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose,
}: Props): React.ReactNode {
  const [isPackageManager, setIsPackageManager] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    async function checkInstallation() {
      // Skip installation type detection if auto-updates are disabled (ant-only)
      // This avoids potentially slow package manager detection (spawnSync calls)
      if (feature('SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED') && isAutoUpdaterDisabled()) {
        logForDebugging('AutoUpdaterWrapper: Skipping detection, auto-updates disabled');
        return;
      }

      const installationType = await getCurrentInstallationType();
      logForDebugging(`AutoUpdaterWrapper: Installation type: ${installationType}`);
      setIsPackageManager(installationType === 'package-manager');
    }

    void checkInstallation();
  }, []);

  // Don't render until we know the installation type
  if (isPackageManager === null) {
    return null;
  }

  if (isPackageManager) {
    return (
      <PackageManagerAutoUpdater
        verbose={verbose}
        onAutoUpdaterResult={onAutoUpdaterResult}
        autoUpdaterResult={autoUpdaterResult}
        isUpdating={isUpdating}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={showSuccessMessage}
      />
    );
  }

  return (
    <AutoUpdater
      verbose={verbose}
      onAutoUpdaterResult={onAutoUpdaterResult}
      autoUpdaterResult={autoUpdaterResult}
      isUpdating={isUpdating}
      onChangeIsUpdating={onChangeIsUpdating}
      showSuccessMessage={showSuccessMessage}
    />
  );
}
