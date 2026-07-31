import { homedir } from 'os';
import { basename, join, sep } from 'path';
import { occConfigDir, PROJECT_DIR_NAME } from 'src/config/paths.js';
import { type ReactNode } from 'react';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import { Text } from '@anthropic/ink';
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { expandPath, getDirectoryForPath } from '../../../utils/path.js';
import { normalizeCaseForComparison, pathInAllowedWorkingPath } from '../../../utils/permissions/filesystem.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
/**
 * Check if a path is within the project's occ config folder.
 */
export function isInOccFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath);
  const occFolderPath = expandPath(join(getOriginalCwd(), PROJECT_DIR_NAME));

  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath);
  const normalizedOccFolderPath = normalizeCaseForComparison(occFolderPath);

  return (
    normalizedAbsolutePath.startsWith(normalizedOccFolderPath + sep.toLowerCase()) ||
    normalizedAbsolutePath.startsWith(normalizedOccFolderPath + '/')
  );
}

/**
 * Check if a path is within the global occ config folder.
 */
export function isInGlobalOccFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath);
  const globalOccFolderPath = occConfigDir();

  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath);
  const normalizedGlobalOccFolderPath = normalizeCaseForComparison(globalOccFolderPath);

  return (
    normalizedAbsolutePath.startsWith(normalizedGlobalOccFolderPath + sep.toLowerCase()) ||
    normalizedAbsolutePath.startsWith(normalizedGlobalOccFolderPath + '/')
  );
}

export type PermissionOption =
  | { type: 'accept-once' }
  | { type: 'accept-session'; scope?: 'occ-folder' | 'global-occ-folder' }
  | { type: 'reject' };

export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption;
};

export type FileOperationType = 'read' | 'write' | 'create';

export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false,
}: {
  filePath: string;
  toolPermissionContext: ToolPermissionContext;
  operationType?: FileOperationType;
  onRejectFeedbackChange?: (value: string) => void;
  onAcceptFeedbackChange?: (value: string) => void;
  yesInputMode?: boolean;
  noInputMode?: boolean;
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = [];
  const modeCycleShortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');

  // When in input mode, show input field
  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: 'and tell Claude what to do next',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'accept-once' },
    });
  } else {
    options.push({
      label: 'Yes',
      value: 'yes',
      option: { type: 'accept-once' },
    });
  }

  const inAllowedPath = pathInAllowedWorkingPath(filePath, toolPermissionContext);

  // Check if this is an occ config folder path (project or global)
  const inOccFolder = isInOccFolder(filePath);
  const inGlobalOccFolder = isInGlobalOccFolder(filePath);

  // Option 2: For occ config folders, show a scoped session option
  // Note: Session-level options are always shown since they only affect in-memory state,
  // not persisted settings. The allowManagedPermissionRulesOnly setting only restricts
  // persisted permission rules.
  if ((inOccFolder || inGlobalOccFolder) && operationType !== 'read') {
    options.push({
      label: `Yes, allow edits to ${PROJECT_DIR_NAME}/ config for this session`,
      value: 'yes-occ-folder',
      option: {
        type: 'accept-session',
        scope: inGlobalOccFolder ? 'global-occ-folder' : 'occ-folder',
      },
    });
  } else {
    // Option 2: Allow all changes/reads during session
    let sessionLabel: ReactNode;

    if (inAllowedPath) {
      // Inside working directory
      if (operationType === 'read') {
        sessionLabel = 'Yes, during this session';
      } else {
        sessionLabel = (
          <Text>
            Yes, allow all edits during this session <Text bold>({modeCycleShortcut})</Text>
          </Text>
        );
      }
    } else {
      // Outside working directory - include directory name
      const dirPath = getDirectoryForPath(filePath);
      const dirName = basename(dirPath) || 'this directory';

      if (operationType === 'read') {
        sessionLabel = (
          <Text>
            Yes, allow reading from <Text bold>{dirName}/</Text> during this session
          </Text>
        );
      } else {
        sessionLabel = (
          <Text>
            Yes, allow all edits in <Text bold>{dirName}/</Text> during this session{' '}
            <Text bold>({modeCycleShortcut})</Text>
          </Text>
        );
      }
    }

    options.push({
      label: sessionLabel,
      value: 'yes-session',
      option: { type: 'accept-session' },
    });
  }

  // When in input mode, show input field for reject
  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: 'and tell Claude what to do differently',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'reject' },
    });
  } else {
    // Not in input mode - simple option
    options.push({
      label: 'No',
      value: 'no',
      option: { type: 'reject' },
    });
  }

  return options;
}
