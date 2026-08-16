import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { type ACPDirectConnection } from './App';
import { purgeLegacyAccountCredentials, readAndScrubPairingCode } from './auth/browser';
import './index.css';

function readAcpDirectConnection(): ACPDirectConnection | null {
  const url = new URL(window.location.href);
  if (url.searchParams.get('acp') !== '1') return null;

  url.searchParams.delete('acp');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);

  const stored = window.sessionStorage.getItem('acp_connection');
  window.sessionStorage.removeItem('acp_connection');
  if (!stored) return null;

  try {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object') return null;
    const connection = value as Record<string, unknown>;
    if (typeof connection.url === 'string' && typeof connection.token === 'string') {
      return { url: connection.url, token: connection.token };
    }
  } catch {
    // The one-time ACP handoff was malformed.
  }
  return null;
}

purgeLegacyAccountCredentials();
const initialPairingCode = readAndScrubPairingCode();
const initialAcpDirect = readAcpDirectConnection();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialPairingCode={initialPairingCode} initialAcpDirect={initialAcpDirect} />
  </StrictMode>,
);
