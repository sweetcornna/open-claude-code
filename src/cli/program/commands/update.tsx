// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { PRODUCT_NAME } from 'src/constants/brand.js';

export function registerUpdateCommand(program: CommanderCommand): void {
  // occ update — update to the latest published version via npm or bun
  program
    .command('update')
    .description(`Update ${PRODUCT_NAME} to the latest version`)
    .action(async () => {
      const { updateOcc } = await import('src/cli/updateOcc.js');
      await updateOcc();
    });
}
