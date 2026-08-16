import { ChevronLeft, LayoutGrid, LoaderCircle, LogOut, UserRound } from 'lucide-react';
import { ThemeToggle } from '../../components/ui/theme-toggle';
import { cn } from '../lib/utils';

interface NavbarProps {
  sessionTitle?: string;
  onBack?: () => void;
  username?: string;
  onLogout?: () => void;
  logoutPending?: boolean;
}

export function Navbar({ sessionTitle, onBack, username, onLogout, logoutPending = false }: NavbarProps) {
  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-surface-1/80 backdrop-blur-md">
      <div className="mx-auto flex h-11 max-w-5xl items-center justify-between px-3 sm:h-12 sm:px-4">
        {sessionTitle ? (
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="flex flex-shrink-0 items-center gap-1 text-sm text-text-muted transition-colors hover:text-text-primary"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </button>
            <span className="text-text-muted/40">/</span>
            <span className="truncate font-display text-sm font-medium text-text-primary">{sessionTitle}</span>
            <span className="flex-shrink-0 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand">
              ACP
            </span>
          </div>
        ) : (
          <a
            href="/code/"
            className="flex items-center gap-2 font-display text-lg font-semibold text-text-primary no-underline"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-shrink-0">
              <path d="M10 1L12.2 7.8L19 10L12.2 12.2L10 19L7.8 12.2L1 10L7.8 7.8L10 1Z" fill="var(--color-brand)" />
            </svg>
            <span className="hidden sm:inline">Remote Control</span>
          </a>
        )}
        <div className="flex items-center gap-0.5 sm:gap-1">
          {!sessionTitle && (
            <a
              href="/code/"
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-text-secondary no-underline transition-colors hover:bg-surface-2 hover:text-text-primary sm:px-3"
              title="Dashboard"
            >
              <LayoutGrid className="h-4 w-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </a>
          )}
          <ThemeToggle />
          {username && (
            <span
              className="hidden max-w-36 items-center gap-1.5 truncate rounded-md px-2 py-1.5 font-display text-xs text-text-secondary sm:flex"
              title={`Signed in as ${username}`}
            >
              <UserRound className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{username}</span>
            </span>
          )}
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              disabled={logoutPending}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50 sm:px-3"
              title="Sign out"
            >
              {logoutPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
              <span className="hidden sm:inline">Sign out</span>
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: 'bg-status-active/20 text-status-active',
    running: 'bg-status-running/20 text-status-running',
    idle: 'bg-status-idle/20 text-status-idle',
    inactive: 'bg-text-muted/20 text-text-muted',
    requires_action: 'bg-status-warning/20 text-status-warning',
    archived: 'bg-text-muted/20 text-text-muted',
    error: 'bg-status-error/20 text-status-error',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        colorMap[status] || 'bg-surface-3 text-text-secondary',
      )}
    >
      {status}
    </span>
  );
}
