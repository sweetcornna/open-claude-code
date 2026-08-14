// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import { Option, type Command as CommanderCommand } from '@commander-js/extra-typings';
import { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES } from 'src/services/plugins/pluginCliCommands.js';
import { registerPluginDetailsCommand } from 'src/commands/plugin/detailsCommand.js';
import { registerPluginEvalCommand } from 'src/commands/plugin/evalCommand.js';
import { createSortedHelpConfig } from '../helpConfig.js';

export function registerPluginCommands(program: CommanderCommand): void {
  /**
   * Helper function to handle marketplace command errors consistently.
   * Logs the error and exits the process with status 1.
   * @param error The error that occurred
   * @param action Description of the action that failed
   */
  // Hidden flag on all plugin/marketplace subcommands to target cowork_plugins.
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp();

  // Plugin validate command
  const pluginCmd = program
    .command('plugin')
    .alias('plugins')
    .description('Manage Claude Code plugins')
    .configureHelp(createSortedHelpConfig());

  registerPluginDetailsCommand(pluginCmd, coworkOption);
  registerPluginEvalCommand(pluginCmd, coworkOption);

  pluginCmd
    .command('validate <path>')
    .description('Validate a plugin or marketplace manifest')
    .addOption(coworkOption())
    .action(async (manifestPath: string, options: { cowork?: boolean }) => {
      const { pluginValidateHandler } = await import('src/cli/handlers/plugins.js');
      await pluginValidateHandler(manifestPath, options);
    });

  // Plugin list command
  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option('--json', 'Output as JSON')
    .option('--available', 'Include available plugins from marketplaces (requires --json)')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; available?: boolean; cowork?: boolean }) => {
      const { pluginListHandler } = await import('src/cli/handlers/plugins.js');
      await pluginListHandler(options);
    });

  // Marketplace subcommands
  const marketplaceCmd = pluginCmd
    .command('marketplace')
    .description('Manage Claude Code marketplaces')
    .configureHelp(createSortedHelpConfig());

  marketplaceCmd
    .command('add <source>')
    .description('Add a marketplace from a URL, path, or GitHub repo')
    .addOption(coworkOption())
    .option(
      '--sparse <paths...>',
      'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .claude-plugin plugins',
    )
    .option('--scope <scope>', 'Where to declare the marketplace: user (default), project, or local')
    .action(
      async (
        source: string,
        options: {
          cowork?: boolean;
          sparse?: string[];
          scope?: string;
        },
      ) => {
        const { marketplaceAddHandler } = await import('src/cli/handlers/plugins.js');
        await marketplaceAddHandler(source, options);
      },
    );

  marketplaceCmd
    .command('list')
    .description('List all configured marketplaces')
    .option('--json', 'Output as JSON')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; cowork?: boolean }) => {
      const { marketplaceListHandler } = await import('src/cli/handlers/plugins.js');
      await marketplaceListHandler(options);
    });

  marketplaceCmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a configured marketplace')
    .addOption(coworkOption())
    .action(async (name: string, options: { cowork?: boolean }) => {
      const { marketplaceRemoveHandler } = await import('src/cli/handlers/plugins.js');
      await marketplaceRemoveHandler(name, options);
    });

  marketplaceCmd
    .command('update [name]')
    .description('Update marketplace(s) from their source - updates all if no name specified')
    .addOption(coworkOption())
    .action(async (name: string | undefined, options: { cowork?: boolean }) => {
      const { marketplaceUpdateHandler } = await import('src/cli/handlers/plugins.js');
      await marketplaceUpdateHandler(name, options);
    });

  // Plugin install command
  pluginCmd
    .command('install <plugin>')
    .alias('i')
    .description('Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)')
    .option('-s, --scope <scope>', 'Installation scope: user, project, or local', 'user')
    .addOption(coworkOption())
    .action(async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
      const { pluginInstallHandler } = await import('src/cli/handlers/plugins.js');
      await pluginInstallHandler(plugin, options);
    });

  // Plugin uninstall command
  pluginCmd
    .command('uninstall <plugin>')
    .alias('remove')
    .alias('rm')
    .description('Uninstall an installed plugin')
    .option('-s, --scope <scope>', 'Uninstall from scope: user, project, or local', 'user')
    .option('--keep-data', "Preserve the plugin's persistent data directory (~/.claude/plugins/data/{id}/)")
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string;
          cowork?: boolean;
          keepData?: boolean;
        },
      ) => {
        const { pluginUninstallHandler } = await import('src/cli/handlers/plugins.js');
        await pluginUninstallHandler(plugin, options);
      },
    );

  // Plugin enable command
  pluginCmd
    .command('enable <plugin>')
    .description('Enable a disabled plugin')
    .option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`)
    .addOption(coworkOption())
    .action(async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
      const { pluginEnableHandler } = await import('src/cli/handlers/plugins.js');
      await pluginEnableHandler(plugin, options);
    });

  // Plugin disable command
  pluginCmd
    .command('disable [plugin]')
    .description('Disable an enabled plugin')
    .option('-a, --all', 'Disable all enabled plugins')
    .option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`)
    .addOption(coworkOption())
    .action(async (plugin: string | undefined, options: { scope?: string; cowork?: boolean; all?: boolean }) => {
      const { pluginDisableHandler } = await import('src/cli/handlers/plugins.js');
      await pluginDisableHandler(plugin, options);
    });

  // Plugin update command
  pluginCmd
    .command('update <plugin>')
    .description('Update a plugin to the latest version (restart required to apply)')
    .option('-s, --scope <scope>', `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`)
    .addOption(coworkOption())
    .action(async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
      const { pluginUpdateHandler } = await import('src/cli/handlers/plugins.js');
      await pluginUpdateHandler(plugin, options);
    });
  // END ANT-ONLY
}
