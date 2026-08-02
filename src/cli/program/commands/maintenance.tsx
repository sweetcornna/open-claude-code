// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { BIN_NAME } from 'src/constants/brand.js';

export function registerMaintenanceCommands(program: CommanderCommand): void {
  // claude up — run the project's CLAUDE.md "# claude up" setup instructions.
  if (process.env.USER_TYPE === 'ant') {
    program
      .command('up')
      .description(
        '[ANT-ONLY] Initialize or upgrade the local dev environment using the "# claude up" section of the nearest CLAUDE.md',
      )
      .action(async () => {
        const { up } = await import('src/cli/up.js');
        await up();
      });
  }

  // claude rollback (ant-only)
  // Rolls back to previous releases
  if (process.env.USER_TYPE === 'ant') {
    program
      .command('rollback [target]')
      .description(
        `[ANT-ONLY] Roll back to a previous release\n\nExamples:\n  ${BIN_NAME} rollback                                    Go 1 version back from current\n  ${BIN_NAME} rollback 3                                  Go 3 versions back from current\n  ${BIN_NAME} rollback 2.0.73-dev.20251217.t190658        Roll back to a specific version`,
      )
      .option('-l, --list', 'List recent published versions with ages')
      .option('--dry-run', 'Show what would be installed without installing')
      .option('--safe', 'Roll back to the server-pinned safe version (set by oncall during incidents)')
      .action(
        async (
          target?: string,
          options?: {
            list?: boolean;
            dryRun?: boolean;
            safe?: boolean;
          },
        ) => {
          const { rollback } = await import('src/cli/rollback.js');
          await rollback(target, options);
        },
      );
  }
}
