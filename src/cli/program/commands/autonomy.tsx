// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

export function registerAutonomyCommands(program: CommanderCommand): void {
  // claude autonomy — CLI subcommands mirroring /autonomy slash command
  {
    const autonomyCmd = program.command('autonomy').description('Inspect and manage automatic autonomy runs and flows');

    autonomyCmd
      .command('status')
      .description('Print autonomy run, flow, team, pipe, and remote-control status')
      .option('--deep', 'Include teams, pipes, daemon, and remote-control sections')
      .action(async (options: { deep?: boolean }) => {
        const { autonomyStatusHandler } = await import('src/cli/handlers/autonomy.js');
        await autonomyStatusHandler(options);
        process.exit(0);
      });

    autonomyCmd
      .command('runs [limit]')
      .description('List recent autonomy runs')
      .action(async (limit?: string) => {
        const { autonomyRunsHandler } = await import('src/cli/handlers/autonomy.js');
        await autonomyRunsHandler(limit);
        process.exit(0);
      });

    autonomyCmd
      .command('flows [limit]')
      .description('List recent autonomy flows')
      .action(async (limit?: string) => {
        const { autonomyFlowsHandler } = await import('src/cli/handlers/autonomy.js');
        await autonomyFlowsHandler(limit);
        process.exit(0);
      });

    const flowCmd = autonomyCmd
      .command('flow <flowId>')
      .description('Inspect a single autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowHandler } = await import('src/cli/handlers/autonomy.js');
        await autonomyFlowHandler(flowId);
        process.exit(0);
      });

    flowCmd
      .command('cancel <flowId>')
      .description('Cancel a queued, waiting, or running autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowCancelHandler } = await import('src/cli/handlers/autonomy.js');
        await autonomyFlowCancelHandler(flowId);
        process.exit(0);
      });

    flowCmd
      .command('resume <flowId>')
      .description('Resume a waiting autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowResumeHandler } = await import('src/cli/handlers/autonomy.js');
        await autonomyFlowResumeHandler(flowId);
        process.exit(0);
      });
  }
}
