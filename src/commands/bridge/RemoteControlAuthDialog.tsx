import * as React from 'react';
import { useState } from 'react';
import { Box, Dialog, ListItem, Text } from '@anthropic/ink';
import TextInput from '../../components/TextInput.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  authenticateRemoteControl,
  RemoteControlAuthError,
  type RemoteControlUser,
} from '../../services/remoteControlAuth/index.js';
import {
  isValidRemoteControlPassword,
  isValidRemoteControlUsername,
  normalizeRemoteControlUsername,
  REMOTE_CONTROL_PASSWORD_ERROR,
  REMOTE_CONTROL_USERNAME_ERROR,
} from './authValidation.js';
import type { RemoteControlAuthAction } from './parseArgs.js';

type AuthAction = RemoteControlAuthAction;
type Step = 'choose' | 'username' | 'password' | 'submitting';

type Props = {
  baseUrl: string;
  registrationEnabled: boolean;
  initialAction?: AuthAction;
  onAuthenticated: (user: RemoteControlUser) => void;
  onCancel: () => void;
};

export function RemoteControlAuthDialog({
  baseUrl,
  registrationEnabled,
  initialAction,
  onAuthenticated,
  onCancel,
}: Props): React.ReactNode {
  useRegisterOverlay('remote-control-auth-dialog');
  const [step, setStep] = useState<Step>(initialAction === undefined ? 'choose' : 'username');
  const [action, setAction] = useState<AuthAction>(initialAction ?? 'login');
  const [choice, setChoice] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [usernameCursor, setUsernameCursor] = useState(0);
  const [passwordCursor, setPasswordCursor] = useState(0);
  const columns = Math.max(20, useTerminalSize().columns - 14);
  const actions: AuthAction[] = registrationEnabled ? ['login', 'register'] : ['login'];

  useKeybindings(
    {
      'select:next': () => setChoice(index => (index + 1) % actions.length),
      'select:previous': () => setChoice(index => (index - 1 + actions.length) % actions.length),
      'select:accept': () => {
        const selected = actions[choice];
        if (!selected) return;
        setAction(selected);
        setStep('username');
        setError(null);
      },
    },
    { context: 'Select', isActive: step === 'choose' },
  );

  function submitUsername(): void {
    const normalized = normalizeRemoteControlUsername(username);
    if (!isValidRemoteControlUsername(normalized)) {
      setError(REMOTE_CONTROL_USERNAME_ERROR);
      return;
    }
    setUsername(normalized);
    setPassword('');
    setPasswordCursor(0);
    setError(null);
    setStep('password');
  }

  function submitPassword(): void {
    if (!isValidRemoteControlPassword(password)) {
      setError(REMOTE_CONTROL_PASSWORD_ERROR);
      return;
    }
    setError(null);
    setStep('submitting');
    void authenticateRemoteControl(baseUrl, action, username, password)
      .then(user => {
        setPassword('');
        onAuthenticated(user);
      })
      .catch((authError: unknown) => {
        setPassword('');
        setPasswordCursor(0);
        if (authError instanceof RemoteControlAuthError) {
          const retry = authError.retryAfterSeconds;
          setError(retry === undefined ? authError.message : `${authError.message} Try again in ${retry}s.`);
        } else {
          setError('Unable to authenticate with the Remote Control server.');
        }
        setStep('password');
      });
  }

  function cancel(): void {
    if (step === 'password') {
      setPassword('');
      setError(null);
      setStep('username');
      return;
    }
    if (step === 'username' && initialAction === undefined) {
      setError(null);
      setStep('choose');
      return;
    }
    onCancel();
  }

  return (
    <Dialog title="Remote Control account" onCancel={cancel} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{baseUrl}</Text>
        {step === 'choose' && (
          <Box flexDirection="column">
            {actions.map((item, index) => (
              <ListItem key={item} isFocused={choice === index}>
                <Text>{item === 'login' ? 'Log in' : 'Register'}</Text>
              </ListItem>
            ))}
          </Box>
        )}
        {step === 'username' && (
          <Box>
            <Text>Username: </Text>
            <TextInput
              value={username}
              onChange={value => {
                setUsername(value);
                setError(null);
              }}
              onSubmit={submitUsername}
              cursorOffset={usernameCursor}
              onChangeCursorOffset={setUsernameCursor}
              columns={columns}
              focus
              multiline={false}
            />
          </Box>
        )}
        {step === 'password' && (
          <Box>
            <Text>Password: </Text>
            <TextInput
              value={password}
              onChange={value => {
                setPassword(value);
                setError(null);
              }}
              onSubmit={submitPassword}
              cursorOffset={passwordCursor}
              onChangeCursorOffset={setPasswordCursor}
              columns={columns}
              focus
              mask="*"
              multiline={false}
            />
          </Box>
        )}
        {step === 'submitting' && <Text dimColor>{action === 'login' ? 'Logging in…' : 'Creating account…'}</Text>}
        {error && <Text color="error">{error}</Text>}
        <Text dimColor>
          {step === 'choose'
            ? 'Enter to select · Esc to cancel'
            : step === 'submitting'
              ? 'Please wait…'
              : 'Enter to continue · Esc to go back'}
        </Text>
      </Box>
    </Dialog>
  );
}
