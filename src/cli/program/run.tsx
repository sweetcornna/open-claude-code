// Extracted verbatim from src/main.tsx (S7-4b split).
//
// Builds the Commander program and parses argv. The `-p`/`--print` early
// return below is a startup budget guard, not a shortcut: it keeps headless
// runs off ./commands entirely. Do not hoist that dynamic import to the top of
// this file.
import { Command as CommanderCommand } from '@commander-js/extra-typings';
import { DISPLAY_NAME } from 'src/constants/brand.js';
import { profileCheckpoint, profileReport } from 'src/utils/startupProfiler.js';
import { createSortedHelpConfig } from './helpConfig.js';
import { registerPreActionHook } from './preAction.js';
import { rootAction } from './rootAction.js';
import { applyExtraRootOptions, applyRootOptions } from './rootOptions.js';

export async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  const program = new CommanderCommand().configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  profileCheckpoint('run_commander_initialized');

  registerPreActionHook(program);

  applyRootOptions(program)
    .action(rootAction)
    .version(`${MACRO.VERSION} (${DISPLAY_NAME})`, '-v, --version', 'Output the version number');

  applyExtraRootOptions(program);

  profileCheckpoint('run_main_options_built');

  // -p/--print mode: skip subcommand registration. The 52 subcommands
  // (mcp, auth, plugin, skill, task, config, doctor, update, etc.) are
  // never dispatched in print mode — commander routes the prompt to the
  // default action. The subcommand registration path was measured at ~65ms
  // on baseline.
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  if (isPrintMode) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // Subcommand registration lives in ./cli/program/commands. It is reached
  // through a dynamic import placed after the print-mode early return above,
  // so headless runs skip both the ~65ms of `.command()` construction and the
  // module loads those registrations would otherwise drag in.
  const { registerSubcommands } = await import('./commands/index.js');
  registerSubcommands(program);

  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
  profileCheckpoint('run_after_parse');

  // Record final checkpoint for total_time calculation
  profileCheckpoint('main_after_run');

  // Log startup perf to Statsig (sampled) and output detailed report if enabled
  profileReport();

  return program;
}
