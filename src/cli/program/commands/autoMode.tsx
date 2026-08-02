// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { feature } from 'bun:bundle';
import { getAutoModeEnabledStateIfCached } from 'src/utils/permissions/permissionSetup.js';

export function registerAutoModeCommands(program: CommanderCommand): void {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Skip when tengu_auto_mode_config.enabled === 'disabled' (circuit breaker).
    // Reads from disk cache — GrowthBook isn't initialized at registration time.
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program.command('auto-mode').description('Inspect auto mode classifier configuration');

      autoModeCmd
        .command('defaults')
        .description('Print the default auto mode environment, allow, and deny rules as JSON')
        .action(async () => {
          const { autoModeDefaultsHandler } = await import('src/cli/handlers/autoMode.js');
          autoModeDefaultsHandler();
          process.exit(0);
        });

      autoModeCmd
        .command('config')
        .description('Print the effective auto mode config as JSON: your settings where set, defaults otherwise')
        .action(async () => {
          const { autoModeConfigHandler } = await import('src/cli/handlers/autoMode.js');
          autoModeConfigHandler();
          process.exit(0);
        });

      autoModeCmd
        .command('critique')
        .description('Get AI feedback on your custom auto mode rules')
        .option('--model <model>', 'Override which model is used')
        .action(async options => {
          const { autoModeCritiqueHandler } = await import('src/cli/handlers/autoMode.js');
          await autoModeCritiqueHandler(options);
          process.exit();
        });
    }
  }
}
