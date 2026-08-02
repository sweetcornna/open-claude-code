// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { feature } from 'bun:bundle';
import { BIN_NAME } from 'src/constants/brand.js';

export function registerAssistantCommand(program: CommanderCommand): void {
  if (feature('KAIROS')) {
    program
      .command('assistant [sessionId]')
      .description(
        'Attach the REPL as a client to a running remote session. Discovers sessions via API if no sessionId given.',
      )
      .action(() => {
        // Argv rewriting above should have consumed `assistant [id]`
        // before commander runs. Reaching here means a root flag came first
        // (e.g. `--debug assistant`) and the position-0 predicate
        // didn't match. Print usage like the ssh stub does.
        process.stderr.write(
          `Usage: ${BIN_NAME} assistant [sessionId]\n\n` +
            'Attach the REPL as a viewer client to a running remote session.\n' +
            'Omit sessionId to discover and pick from available sessions.\n',
        );
        process.exit(1);
      });
  }
}
