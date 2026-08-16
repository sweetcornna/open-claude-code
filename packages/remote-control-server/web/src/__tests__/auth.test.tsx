import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/client';
import { AuthGateView, bootstrapAuth } from '../auth/AuthProvider';
import { purgeLegacyAccountCredentials, readAndScrubPairingCode } from '../auth/browser';
import { ThemeProvider } from '../lib/theme';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    matchMedia: () => ({ matches: false }),
  },
});

const capabilities = {
  auth_mode: 'accounts',
  registration_enabled: true,
};

const noOpAuthenticate = async () => {};

function renderGate(props: Partial<Parameters<typeof AuthGateView>[0]> = {}): string {
  Object.defineProperty(globalThis.window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false }),
  });
  return renderToStaticMarkup(
    <ThemeProvider>
      <AuthGateView
        phase="authenticated"
        user={{ id: 'user_1', username: 'dev' }}
        capabilities={capabilities}
        pairing={false}
        message={null}
        pending={false}
        onAuthenticate={noOpAuthenticate}
        {...props}
      >
        <div>private dashboard</div>
      </AuthGateView>
    </ThemeProvider>,
  );
}

describe('account auth gate', () => {
  test('does not render dashboard routes while authentication is loading', () => {
    const html = renderGate({ phase: 'loading', user: null });

    expect(html).toContain('Checking your session');
    expect(html).not.toContain('private dashboard');
  });

  test('shows login and registration when the server enables both', () => {
    const html = renderGate({ phase: 'unauthenticated', user: null });

    expect(html).toContain('Sign in');
    expect(html).toContain('Create account');
    expect(html).not.toContain('private dashboard');
  });

  test('hides registration when the server disables it', () => {
    const html = renderGate({
      phase: 'unauthenticated',
      user: null,
      capabilities: { ...capabilities, registration_enabled: false },
    });

    expect(html).toContain('Sign in');
    expect(html).not.toContain('Create account');
    expect(html).toContain('managed by this server');
  });

  test('renders dashboard routes only for an authenticated account', () => {
    const html = renderGate();

    expect(html).toContain('private dashboard');
    expect(html).not.toContain('Welcome back');
  });
});

describe('pairing fragment', () => {
  test('reads and immediately scrubs the one-time pairing code', () => {
    let href = 'https://rcs.example.test/code/session_7?panel=chat#pair=secret%2Bonce&tab=activity';
    const location = {
      get href() {
        return href;
      },
      get hash() {
        return new URL(href).hash;
      },
    };
    const replacements: string[] = [];
    const history = {
      state: { navigation: 1 },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        const next = String(url);
        replacements.push(next);
        href = `https://rcs.example.test${next}`;
      },
    };

    expect(readAndScrubPairingCode(location, history)).toBe('secret+once');
    expect(replacements).toEqual(['/code/session_7?panel=chat#tab=activity']);
    expect(href).not.toContain('secret');
    expect(readAndScrubPairingCode(location, history)).toBeNull();
  });

  test('authenticates once and returns the paired current session', async () => {
    let pairCalls = 0;
    const result = await bootstrapAuth('one-time-code', {
      fetchCapabilities: async () => capabilities,
      fetchMe: async () => {
        throw new Error('me should not run after successful pairing');
      },
      pair: async code => {
        pairCalls += 1;
        expect(code).toBe('one-time-code');
        return {
          user: { id: 'user_1', username: 'dev' },
          session_id: 'session_7',
        };
      },
    });

    expect(pairCalls).toBe(1);
    expect(result.user?.username).toBe('dev');
    expect(result.pairedSessionId).toBe('session_7');
    expect(result.message).toBeNull();
  });

  test('handles failed or reused pairing codes without retrying them', async () => {
    let pairCalls = 0;
    const dependencies = {
      fetchCapabilities: async () => capabilities,
      fetchMe: async () => {
        throw new ApiError('Sign in required', 401, 'unauthorized');
      },
      pair: async () => {
        pairCalls += 1;
        throw new ApiError('Invalid pairing code', 401, 'invalid_pairing');
      },
    };

    const failed = await bootstrapAuth('already-used', dependencies);
    const afterScrub = await bootstrapAuth(null, dependencies);

    expect(pairCalls).toBe(1);
    expect(failed.user).toBeNull();
    expect(failed.pairedSessionId).toBeNull();
    expect(failed.message).toBe('This pairing link is invalid or has already been used. Sign in to continue.');
    expect(afterScrub.message).toBeNull();
  });
});

describe('legacy account storage migration', () => {
  test('removes UUID and raw token storage without writing credentials', () => {
    const removed: string[] = [];
    const storage = {
      removeItem: (key: string) => removed.push(key),
    };

    purgeLegacyAccountCredentials(storage);

    expect(removed).toEqual(['rcs_uuid', 'rcs_tokens']);
  });
});
