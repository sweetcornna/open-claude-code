// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';
import { getBaseRenderOptions } from 'src/utils/terminal/renderOptions.js';
import { createSortedHelpConfig } from '../helpConfig.js';

export function registerAuthCommands(program: CommanderCommand): void {
  // claude auth

  const auth = program.command('auth').description('Manage authentication').configureHelp(createSortedHelpConfig());

  auth
    .command('login')
    .description('Sign in to your Anthropic account')
    .option('--email <email>', 'Pre-populate email address on the login page')
    .option('--sso', 'Force SSO login flow')
    .option('--console', 'Use Anthropic Console (API usage billing) instead of Claude subscription')
    .option('--claudeai', 'Use Claude subscription (default)')
    .action(
      async ({
        email,
        sso,
        console: useConsole,
        claudeai,
      }: {
        email?: string;
        sso?: boolean;
        console?: boolean;
        claudeai?: boolean;
      }) => {
        const { authLogin } = await import('src/cli/handlers/auth.js');
        await authLogin({ email, sso, console: useConsole, claudeai });
      },
    );

  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .action(async (opts: { json?: boolean; text?: boolean }) => {
      const { authStatus } = await import('src/cli/handlers/auth.js');
      await authStatus(opts);
    });

  auth
    .command('logout')
    .description('Log out from your Anthropic account')
    .action(async () => {
      const { authLogout } = await import('src/cli/handlers/auth.js');
      await authLogout();
    });
}

export function registerSetupTokenCommand(program: CommanderCommand): void {
  // Setup token command
  program
    .command('setup-token')
    .description('Set up a long-lived authentication token (requires Claude subscription)')
    .action(async () => {
      const [{ setupTokenHandler }, { createRoot }] = await Promise.all([
        import('src/cli/handlers/util.js'),
        import('@anthropic/ink'),
      ]);
      const root = await createRoot(getBaseRenderOptions(false));
      await setupTokenHandler(root);
    });
}
