// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { getBaseRenderOptions } from 'src/utils/renderOptions.js';

export function registerDoctorCommand(program: CommanderCommand): void {
  // Doctor command - check installation health
  program
    .command('doctor')
    .description(
      'Check the health of your Claude Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const [{ doctorHandler }, { createRoot }] = await Promise.all([
        import('src/cli/handlers/util.js'),
        import('@anthropic/ink'),
      ]);
      const root = await createRoot(getBaseRenderOptions(false));
      await doctorHandler(root);
    });
}
