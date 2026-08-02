// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { feature } from 'bun:bundle';

export function registerRemoteControlCommand(program: CommanderCommand): void {
  // Remote Control command — run this machine's occ as an ACP agent under
  // Happy, which supplies the mobile/web clients and the (self-hostable) relay.
  // The actual command is intercepted by the fast-path in cli.tsx before
  // Commander.js runs, so this registration exists only for help output.
  if (feature('ACP')) {
    program
      .command('remote-control')
      .alias('rc')
      .description('Control this session from your phone or browser via Happy (runs `happy acp -- occ --acp`)')
      .action(async () => {
        // Normally unreachable — cli.tsx intercepts this command before
        // main.tsx loads. Kept as a fallback if the fast path is bypassed.
        const { runRemoteControlLauncher } = await import('src/cli/remoteControlLauncher.js');
        process.exit(await runRemoteControlLauncher(process.argv.slice(3)));
      });
  }
}
