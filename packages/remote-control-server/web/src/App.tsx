import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ACPDirectView } from './components/ACPDirectView';
import { Navbar } from './components/Navbar';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { ThemeProvider } from './lib/theme';

const Dashboard = lazy(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const SessionDetail = lazy(() =>
  import('./pages/SessionDetail').then(module => ({
    default: module.SessionDetail,
  })),
);

export interface ACPDirectConnection {
  url: string;
  token: string;
}

interface AppProps {
  initialPairingCode?: string | null;
  initialAcpDirect?: ACPDirectConnection | null;
}

function sessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/code\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export default function App({ initialPairingCode = null, initialAcpDirect = null }: AppProps) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() =>
    sessionIdFromPath(window.location.pathname),
  );
  const [acpDirect, setAcpDirect] = useState(initialAcpDirect);

  const parseRoute = useCallback(() => {
    setCurrentSessionId(sessionIdFromPath(window.location.pathname));
  }, []);

  useEffect(() => {
    window.addEventListener('popstate', parseRoute);
    return () => window.removeEventListener('popstate', parseRoute);
  }, [parseRoute]);

  const navigateToSession = useCallback((sessionId: string) => {
    window.history.pushState(null, '', `/code/${encodeURIComponent(sessionId)}`);
    setCurrentSessionId(sessionId);
  }, []);

  const navigateToPairedSession = useCallback((sessionId: string) => {
    window.history.replaceState(null, '', `/code/${encodeURIComponent(sessionId)}`);
    setAcpDirect(null);
    setCurrentSessionId(sessionId);
  }, []);

  const navigateToDashboard = useCallback(() => {
    window.history.pushState(null, '', '/code/');
    setCurrentSessionId(null);
    setAcpDirect(null);
  }, []);

  return (
    <ThemeProvider defaultTheme="system">
      {acpDirect ? (
        <AppFrame
          currentSessionId={null}
          acpDirect={acpDirect}
          onNavigateSession={navigateToSession}
          onNavigateDashboard={navigateToDashboard}
        />
      ) : (
        <AuthProvider initialPairingCode={initialPairingCode} onPairedSession={navigateToPairedSession}>
          <AccountApp
            currentSessionId={currentSessionId}
            onNavigateSession={navigateToSession}
            onNavigateDashboard={navigateToDashboard}
          />
        </AuthProvider>
      )}
    </ThemeProvider>
  );
}

interface AccountAppProps {
  currentSessionId: string | null;
  onNavigateSession: (sessionId: string) => void;
  onNavigateDashboard: () => void;
}

function AccountApp({ currentSessionId, onNavigateSession, onNavigateDashboard }: AccountAppProps) {
  const { user, logout, logoutPending, notice, dismissNotice } = useAuth();

  return (
    <AppFrame
      currentSessionId={currentSessionId}
      onNavigateSession={onNavigateSession}
      onNavigateDashboard={onNavigateDashboard}
      username={user.username}
      onLogout={() => void logout()}
      logoutPending={logoutPending}
      notice={notice}
      onDismissNotice={dismissNotice}
    />
  );
}

interface AppFrameProps {
  currentSessionId: string | null;
  acpDirect?: ACPDirectConnection | null;
  onNavigateSession: (sessionId: string) => void;
  onNavigateDashboard: () => void;
  username?: string;
  onLogout?: () => void;
  logoutPending?: boolean;
  notice?: string | null;
  onDismissNotice?: () => void;
}

function AppFrame({
  currentSessionId,
  acpDirect = null,
  onNavigateSession,
  onNavigateDashboard,
  username,
  onLogout,
  logoutPending,
  notice,
  onDismissNotice,
}: AppFrameProps) {
  return (
    <div className="flex h-screen flex-col bg-surface-0 text-text-primary">
      <Navbar
        username={username}
        onLogout={onLogout}
        logoutPending={logoutPending}
        sessionTitle={currentSessionId || (acpDirect ? 'ACP' : undefined)}
        onBack={currentSessionId || acpDirect ? onNavigateDashboard : undefined}
      />

      {notice && (
        <div
          role="status"
          className="border-b border-status-warning/25 bg-warning-bg px-4 py-2 text-sm text-warning-text"
        >
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
            <span>{notice}</span>
            {onDismissNotice && (
              <button
                type="button"
                onClick={onDismissNotice}
                className="font-display text-xs font-medium underline-offset-2 hover:underline"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-text-muted">Loading…</div>}>
        {acpDirect ? (
          <ACPDirectView url={acpDirect.url} token={acpDirect.token} onBack={onNavigateDashboard} />
        ) : currentSessionId ? (
          <SessionDetail key={currentSessionId} sessionId={currentSessionId} />
        ) : (
          <div className="flex-1 overflow-y-auto">
            <Dashboard onNavigateSession={onNavigateSession} />
          </div>
        )}
      </Suspense>
    </div>
  );
}
