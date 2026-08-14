// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

export function registerAgentsCommand(program: CommanderCommand): void {
  // Agents command - interactive session list on a TTY, agent definitions with --list
  program
    .command('agents')
    .description('View running and recent sessions (use --list for configured agents)')
    .option('--list', 'Print configured agent definitions instead of the interactive session list')
    .option('--json', 'Print the running and recent sessions as a JSON array (no TTY required)')
    .option('--all', 'With --json, also include ended (resumable) sessions')
    .option('--cwd <dir>', 'With --json, only include sessions whose working directory is this directory or below')
    .option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
    .action(async options => {
      // Everything below stays behind `await import()`: a top-level import here
      // would load the Ink tree on the print-mode path too. See run.tsx.
      const { agentsHandler, agentsJsonHandler, shouldMountFleetView } = await import('src/cli/handlers/agents.js');
      if (options.json) {
        await agentsJsonHandler({ all: options.all, cwd: options.cwd });
        process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
      }
      if (
        shouldMountFleetView(options, {
          stdoutIsTTY: process.stdout.isTTY,
          stdinIsTTY: process.stdin.isTTY,
        })
      ) {
        const { fleetViewHandler } = await import('src/cli/handlers/fleetView.js');
        await fleetViewHandler();
      } else {
        await agentsHandler();
      }
      // Ink can leave event loop handles that prevent a natural exit
      // (see the note in src/entrypoints/cli.tsx).
      process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
    });
}
