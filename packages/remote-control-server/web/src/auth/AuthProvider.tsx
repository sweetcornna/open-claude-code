import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ArrowRight, CircleCheck, LoaderCircle, LogIn } from 'lucide-react';
import { ThemeToggle } from '../../components/ui/theme-toggle';
import {
  ApiError,
  type AccountUser,
  type AuthCapabilities,
  apiFetchAuthCapabilities,
  apiFetchMe,
  apiLogin,
  apiLogout,
  apiPair,
  apiRegister,
} from '../api/client';

const DEFAULT_CAPABILITIES: AuthCapabilities = {
  auth_mode: 'accounts',
  registration_enabled: false,
};

const PAIRING_FAILURE_MESSAGE = 'This pairing link is invalid or has already been used. Sign in to continue.';

interface AuthDependencies {
  fetchCapabilities: typeof apiFetchAuthCapabilities;
  fetchMe: typeof apiFetchMe;
  pair: typeof apiPair;
}

interface AuthBootstrapResult {
  capabilities: AuthCapabilities;
  user: AccountUser | null;
  pairedSessionId: string | null;
  message: string | null;
}

const defaultDependencies: AuthDependencies = {
  fetchCapabilities: apiFetchAuthCapabilities,
  fetchMe: apiFetchMe,
  pair: apiPair,
};

function messageForError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.type === 'invalid_pairing') {
    return PAIRING_FAILURE_MESSAGE;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function bootstrapAuth(
  pairingCode: string | null,
  dependencies: AuthDependencies = defaultDependencies,
): Promise<AuthBootstrapResult> {
  const capabilitiesPromise = dependencies.fetchCapabilities().catch(() => DEFAULT_CAPABILITIES);

  let pairingMessage: string | null = null;
  if (pairingCode) {
    try {
      const paired = await dependencies.pair(pairingCode);
      return {
        capabilities: await capabilitiesPromise,
        user: paired.user,
        pairedSessionId: paired.session_id,
        message: null,
      };
    } catch (error) {
      pairingMessage = messageForError(error, PAIRING_FAILURE_MESSAGE);
    }
  }

  try {
    const current = await dependencies.fetchMe();
    return {
      capabilities: await capabilitiesPromise,
      user: current.user,
      pairedSessionId: null,
      message: pairingMessage,
    };
  } catch (error) {
    const unauthenticated = error instanceof ApiError && error.status === 401;
    return {
      capabilities: await capabilitiesPromise,
      user: null,
      pairedSessionId: null,
      message: pairingMessage || (unauthenticated ? null : messageForError(error, 'Could not reach Remote Control.')),
    };
  }
}

interface AuthContextValue {
  user: AccountUser;
  logout: () => Promise<void>;
  logoutPending: boolean;
  notice: string | null;
  dismissNotice: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

interface AuthProviderProps {
  children: ReactNode;
  initialPairingCode: string | null;
  onPairedSession: (sessionId: string) => void;
}

type AuthPhase = 'loading' | 'unauthenticated' | 'authenticated';
type AuthMode = 'login' | 'register';

export function AuthProvider({ children, initialPairingCode, onPairedSession }: AuthProviderProps) {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [user, setUser] = useState<AccountUser | null>(null);
  const [capabilities, setCapabilities] = useState(DEFAULT_CAPABILITIES);
  const [message, setMessage] = useState<string | null>(null);
  const [authPending, setAuthPending] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const bootstrapStarted = useRef(false);

  useEffect(() => {
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;

    void bootstrapAuth(initialPairingCode).then(result => {
      setCapabilities(result.capabilities);
      setUser(result.user);
      setMessage(result.message);
      setPhase(result.user ? 'authenticated' : 'unauthenticated');
      if (result.pairedSessionId) {
        onPairedSession(result.pairedSessionId);
      }
    });
  }, [initialPairingCode, onPairedSession]);

  const authenticate = useCallback(async (mode: AuthMode, username: string, password: string) => {
    setAuthPending(true);
    setMessage(null);
    try {
      const response = mode === 'register' ? await apiRegister(username, password) : await apiLogin(username, password);
      setUser(response.user);
      setPhase('authenticated');
    } catch (error) {
      setMessage(messageForError(error, mode === 'register' ? 'Could not create the account.' : 'Could not sign in.'));
    } finally {
      setAuthPending(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setLogoutPending(true);
    setMessage(null);
    try {
      await apiLogout();
      setUser(null);
      setPhase('unauthenticated');
    } catch (error) {
      setMessage(messageForError(error, 'Could not sign out. Try again.'));
    } finally {
      setLogoutPending(false);
    }
  }, []);

  const dismissNotice = useCallback(() => setMessage(null), []);

  const contextValue: AuthContextValue | null = user
    ? { user, logout, logoutPending, notice: message, dismissNotice }
    : null;

  return (
    <AuthGateView
      phase={phase}
      user={user}
      capabilities={capabilities}
      pairing={Boolean(initialPairingCode)}
      message={message}
      pending={authPending}
      onAuthenticate={authenticate}
    >
      {contextValue ? <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider> : null}
    </AuthGateView>
  );
}

interface AuthGateViewProps {
  phase: AuthPhase;
  user: AccountUser | null;
  capabilities: AuthCapabilities;
  pairing: boolean;
  message: string | null;
  pending: boolean;
  onAuthenticate: (mode: AuthMode, username: string, password: string) => Promise<void>;
  children: ReactNode;
}

export function AuthGateView({
  phase,
  user,
  capabilities,
  pairing,
  message,
  pending,
  onAuthenticate,
  children,
}: AuthGateViewProps) {
  if (phase === 'loading') return <AuthLoading pairing={pairing} />;
  if (!user) {
    return <AuthPage capabilities={capabilities} message={message} pending={pending} onAuthenticate={onAuthenticate} />;
  }
  return children;
}

function BrandMark() {
  return (
    <span className="flex items-center gap-2.5 font-display text-base font-semibold text-text-primary">
      <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 1L12.2 7.8L19 10L12.2 12.2L10 19L7.8 12.2L1 10L7.8 7.8L10 1Z" fill="var(--color-brand)" />
      </svg>
      Remote Control
    </span>
  );
}

function AuthLoading({ pairing }: { pairing: boolean }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-0 text-text-primary">
      <header className="flex h-14 items-center justify-between px-5 sm:px-8">
        <BrandMark />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-6">
        <div className="text-center" role="status">
          <LoaderCircle className="mx-auto mb-4 h-7 w-7 animate-spin text-brand" />
          <p className="font-display text-sm font-medium">
            {pairing ? 'Pairing this browser…' : 'Checking your session…'}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {pairing
              ? 'The pairing code has been removed from the address bar.'
              : 'Your browser will send its secure session cookie.'}
          </p>
        </div>
      </main>
    </div>
  );
}

interface AuthPageProps {
  capabilities: AuthCapabilities;
  message: string | null;
  pending: boolean;
  onAuthenticate: (mode: AuthMode, username: string, password: string) => Promise<void>;
}

function AuthPage({ capabilities, message, pending, onAuthenticate }: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const registrationEnabled = capabilities.registration_enabled;
  const selectMode = (nextMode: AuthMode) => {
    if (nextMode === 'register' && !registrationEnabled) return;
    setMode(nextMode);
    setPassword('');
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onAuthenticate(mode, username.trim(), password);
  };

  return (
    <div className="flex min-h-screen flex-col bg-surface-0 text-text-primary">
      <header className="flex h-14 items-center justify-between px-5 sm:px-8">
        <BrandMark />
        <ThemeToggle />
      </header>

      <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-12 px-5 py-8 md:grid-cols-[1fr_26rem] md:px-8">
        <section className="hidden max-w-lg md:block" aria-labelledby="auth-thesis">
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.2em] text-brand">
            Account link · browser secured
          </p>
          <h1
            id="auth-thesis"
            className="max-w-md font-display text-4xl font-semibold leading-[1.12] tracking-[-0.035em]"
          >
            Step away from the terminal, not the session.
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-text-secondary">
            Follow active agents, answer permission requests, and keep work moving from any signed-in browser.
          </p>

          <div className="relative mt-10 ml-1 space-y-5 border-l border-brand/35 pl-6">
            <ConnectionStep label="Browser" detail="HttpOnly account session" active />
            <ConnectionStep label="Remote Control" detail="Same-origin channel" />
            <ConnectionStep label="Your agent" detail="Live terminal session" />
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-surface-1 p-5 shadow-[0_18px_50px_rgba(38,31,27,0.08)] sm:p-7">
          <div className="mb-6 md:hidden">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand">Account access</p>
            <h1 className="mt-2 font-display text-2xl font-semibold leading-tight tracking-[-0.025em]">
              Stay with your session.
            </h1>
          </div>

          <div className="mb-6 flex rounded-lg bg-surface-0 p-1 font-display text-sm">
            <button
              type="button"
              aria-pressed={mode === 'login'}
              onClick={() => selectMode('login')}
              className={`flex-1 rounded-md px-3 py-2 transition-colors ${
                mode === 'login'
                  ? 'bg-surface-2 text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Sign in
            </button>
            {registrationEnabled && (
              <button
                type="button"
                aria-pressed={mode === 'register'}
                onClick={() => selectMode('register')}
                className={`flex-1 rounded-md px-3 py-2 transition-colors ${
                  mode === 'register'
                    ? 'bg-surface-2 text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                Create account
              </button>
            )}
          </div>

          <div className="mb-5">
            <h2 className="font-display text-xl font-semibold">
              {mode === 'register' ? 'Create your account' : 'Welcome back'}
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              {mode === 'register'
                ? 'Use one account for your paired terminals and browsers.'
                : 'Sign in to open your environments and sessions.'}
            </p>
          </div>

          {message && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-status-error/25 bg-status-error/8 px-3 py-2.5 text-sm leading-5 text-status-error"
            >
              {message}
            </div>
          )}

          <form className="space-y-4" onSubmit={handleSubmit}>
            <label className="block">
              <span className="mb-1.5 block font-display text-xs font-medium text-text-secondary">Username</span>
              <input
                name="username"
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                minLength={3}
                maxLength={32}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}"
                required
                autoFocus
                className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 font-display text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block font-display text-xs font-medium text-text-secondary">Password</span>
              <input
                name="password"
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                minLength={mode === 'register' ? 12 : undefined}
                maxLength={128}
                required
                className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 font-display text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
              />
              {mode === 'register' && (
                <span className="mt-1.5 block text-xs text-text-muted">Use at least 12 characters.</span>
              )}
            </label>

            <button
              type="submit"
              disabled={pending || !username.trim() || !password}
              className="group flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-display text-sm font-medium text-white transition-colors hover:bg-brand-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : mode === 'register' ? (
                <CircleCheck className="h-4 w-4" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              {pending
                ? mode === 'register'
                  ? 'Creating account…'
                  : 'Signing in…'
                : mode === 'register'
                  ? 'Create account'
                  : 'Sign in'}
              {!pending && <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
            </button>
          </form>

          {!registrationEnabled && (
            <p className="mt-5 border-t border-border pt-4 text-center text-xs text-text-muted">
              New accounts are managed by this server’s administrator.
            </p>
          )}

          <p className="mt-4 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
            Same-origin · HttpOnly session
          </p>
        </section>
      </main>
    </div>
  );
}

function ConnectionStep({ label, detail, active = false }: { label: string; detail: string; active?: boolean }) {
  return (
    <div className="relative">
      <span
        className={`absolute -left-[1.72rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface-0 ${
          active ? 'bg-brand' : 'bg-surface-3'
        }`}
      />
      <p className="font-display text-sm font-medium">{label}</p>
      <p className="mt-0.5 font-mono text-xs text-text-muted">{detail}</p>
    </div>
  );
}
