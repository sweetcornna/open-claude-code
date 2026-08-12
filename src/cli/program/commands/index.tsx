// Subcommand registration for the root Commander program (S7-4b split).
//
// IMPORTANT — startup budget: this barrel and everything it imports must stay
// off the `-p`/`--print` path. `run()` reaches it only through a dynamic
// `import()` placed *after* the print-mode early return, so headless runs never
// pay for these modules (previously they only skipped the ~65ms of `.command()`
// construction; now they skip the module loads as well).
//
// The call order below is the registration order of the former inline blocks in
// `src/main.tsx` and is preserved deliberately.
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { registerAgentsCommand } from './agents.js';
import { registerAntOnlyCommands } from './antOnly.js';
import { registerAssistantCommand } from './assistant.js';
import { registerAuthCommands, registerSetupTokenCommand } from './auth.js';
import { registerAutoModeCommands } from './autoMode.js';
import { registerAutonomyCommands } from './autonomy.js';
import { registerDoctorCommand } from './doctor.js';
import { registerMaintenanceCommands } from './maintenance.js';
import { registerMcpCommands } from './mcp.js';
import { registerMigrateCommand } from './migrate.js';
import { registerPluginCommands } from './plugin.js';
import { registerProjectCommands } from './project.js';
import { registerRemoteControlCommand } from './remoteControl.js';
import { registerSshCommand } from './ssh.js';
import { registerUpdateCommand } from './update.js';

export function registerSubcommands(program: CommanderCommand): void {
  registerMcpCommands(program);
  registerSshCommand(program);
  registerAuthCommands(program);
  registerPluginCommands(program);
  registerSetupTokenCommand(program);
  registerAgentsCommand(program);
  registerAutoModeCommands(program);
  registerAutonomyCommands(program);
  registerRemoteControlCommand(program);
  registerAssistantCommand(program);
  registerMigrateCommand(program);
  registerDoctorCommand(program);
  registerProjectCommands(program);
  registerMaintenanceCommands(program);
  registerUpdateCommand(program);
  registerAntOnlyCommands(program);
}
