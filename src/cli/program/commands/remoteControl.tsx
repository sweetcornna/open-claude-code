// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { feature } from 'bun:bundle';

export function registerRemoteControlCommand(program: CommanderCommand): void {
  // The entrypoint intercepts this command before Commander.js runs, so this
  // registration primarily supplies help output and a fallback action.
  if (feature('BRIDGE_MODE')) {
    program
      .command('remote-control')
      .alias('rc')
      .description('Serve this machine for Remote Control sessions')
      .action(async () => {
        const { bridgeMain } = await import('src/bridge/bridgeMain.js');
        await bridgeMain(process.argv.slice(3));
      });
  }
}
