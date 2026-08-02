import * as React from 'react';
import { useState } from 'react';
import { BIN_NAME } from 'src/constants/brand.js';
import { useInterval } from 'usehooks-ts';
import { Text } from '@anthropic/ink';
import {
  type AutoUpdaterResult,
  getLatestVersion,
  getMaxVersion,
  shouldSkipVersion,
} from '../utils/update/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config/config.js';
import { logForDebugging } from '../utils/debug.js';
import { gt, gte } from '../utils/text/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';

type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};

export function PackageManagerAutoUpdater({ verbose }: Props): React.ReactNode {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const checkForUpdates = React.useCallback(async () => {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      return;
    }

    if (isAutoUpdaterDisabled()) {
      return;
    }

    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest';
    let latest = await getLatestVersion(channel);

    // Check if max version is set (server-side kill switch for auto-updates)
    const maxVersion = await getMaxVersion();

    if (maxVersion && latest && gt(latest, maxVersion)) {
      logForDebugging(
        `PackageManagerAutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latest} to ${maxVersion}`,
      );
      if (gte(MACRO.VERSION, maxVersion)) {
        logForDebugging(
          `PackageManagerAutoUpdater: current version ${MACRO.VERSION} is already at or above maxVersion ${maxVersion}, skipping update`,
        );
        setUpdateAvailable(false);
        return;
      }
      latest = maxVersion;
    }

    const hasUpdate = latest && !gte(MACRO.VERSION, latest) && !shouldSkipVersion(latest);

    setUpdateAvailable(!!hasUpdate);

    if (hasUpdate) {
      logForDebugging(`PackageManagerAutoUpdater: Update available ${MACRO.VERSION} -> ${latest}`);
    }
  }, []);

  // Initial check
  React.useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // Check every 30 minutes
  useInterval(checkForUpdates, 30 * 60 * 1000);

  if (!updateAvailable) {
    return null;
  }

  return (
    <>
      {verbose && (
        <Text dimColor wrap="truncate">
          currentVersion: {MACRO.VERSION}
        </Text>
      )}
      <Text color="warning" wrap="truncate">
        Update available! Run: <Text bold>{BIN_NAME} update</Text>
      </Text>
    </>
  );
}
