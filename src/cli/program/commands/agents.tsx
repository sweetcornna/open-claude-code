// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

export function registerAgentsCommand(program: CommanderCommand): void {
  // Agents command - list configured agents
  program
    .command('agents')
    .description('List configured agents')
    .option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
    .action(async () => {
      const { agentsHandler } = await import('src/cli/handlers/agents.js');
      await agentsHandler();
      process.exit(0);
    });
}
