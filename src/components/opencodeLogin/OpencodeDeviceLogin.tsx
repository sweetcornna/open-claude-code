/**
 * OpenCode Console sign-in: RFC 8628 device code, polled to completion.
 *
 * Shaped after AntigravityOAuthSetup rather than invented: request → show the
 * URL and open a browser → spin while the user finishes → write settings →
 * hand off. The differences are the ones the protocol forces.
 *
 *   - There is a `user_code` to type, so it is the loudest thing on screen.
 *   - `verification_uri_complete` is server-RELATIVE; `requestDeviceCode` has
 *     already joined it onto the console origin, so the URL rendered here is
 *     the absolute one and is safe to open and to copy.
 *   - Polling runs for up to 15 minutes, so Esc has to actually stop it. The
 *     AbortController is held in a ref and shared by the key handler and the
 *     unmount cleanup: `pollForTokens` checks the signal at the top of every
 *     iteration AND passes it to fetch, so an abort is seen within one tick
 *     rather than at the next interval.
 *
 * The access token never leaves this module. It goes to the 0600 credential
 * file and into the in-memory runtime slot; it is not rendered, not logged, and
 * not handed to the setup wizard (whose API-key field is written to
 * settings.env). See loginPlan.ts.
 *
 * A successful device code is NOT a successful login. The console mints a token
 * for the account; the two products are billed separately, and both answer
 * `GET /models` without any credential — so signing in, naming the account and
 * filling a model picker all succeed for someone who cannot use the endpoint
 * they picked. `verifyOpencodeAccess` is therefore the gate, and it runs BEFORE
 * anything is written: a rejected credential leaves settings, `process.env` and
 * the runtime slot exactly as they were and puts the user on the error screen
 * with a reason and Enter-to-retry, instead of dropping them into a REPL where
 * every request comes back `Invalid API key`.
 *
 * One account, two products. The device flow is identical for Zen and Go — the
 * console mints the same token — but everything downstream of it is not: the
 * base URL written to settings, the catalog fetched, and who gets billed. So
 * the product is a PROP rather than a constant. It used to be hard-coded to
 * Zen, which left a Go subscriber no way to reach their own endpoint except by
 * typing its URL from memory, and a session pointed at Zen bills the Zen credit
 * balance and fails with "Insufficient balance".
 */

import { Box, Link, Text } from '@anthropic/ink';
import React, { useEffect, useRef, useState } from 'react';
import { useKeybinding } from 'src/keybindings/useKeybinding.js';
import {
  type DeviceCodeGrant,
  fetchAccount,
  fetchOpencodeModels,
  OPENCODE_CONSOLE_URL,
  type OpencodeAccount,
  pollForTokens,
  requestDeviceCode,
  saveOpencodeTokens,
  verifyOpencodeAccess,
} from 'src/services/auth/opencode/index.js';
import type { ProviderModelSetupStatus } from 'src/components/providerSetup/state.js';
import { prefillTierFields } from 'src/components/providerSetup/tierPersistence.js';
import { openBrowser } from 'src/utils/network/browser.js';
import { getSettingsForSource } from 'src/utils/settings/settings.js';
import { Spinner } from '../Spinner.js';
import { activateOpencodeConsoleSession } from './activateSession.js';
import { buildOpencodeModelStep, describeOpencodeAccount } from './loginPlan.js';
import { OPENCODE_PRODUCTS, type OpencodeProduct, withLaneLabels } from './opencodeCatalog.js';

export type OpencodeDevicePhase = 'requesting' | 'waiting' | 'finishing';

type OpencodeDeviceLoginProps = {
  /** Which endpoint this login configures — Zen or Go. */
  product: OpencodeProduct;
  phase: OpencodeDevicePhase;
  grant?: DeviceCodeGrant;
  /** Advance the host's status as the flow moves through its phases. */
  onPhase: (phase: OpencodeDevicePhase, grant?: DeviceCodeGrant) => void;
  /** Tokens stored and settings written; continue into the model step. */
  onReady: (status: ProviderModelSetupStatus) => void;
  onError: (message: string) => void;
  /** Esc, after the poll has been aborted. */
  onCancel: () => void;
};

export function OpencodeDeviceLogin({
  product,
  phase,
  grant,
  onPhase,
  onReady,
  onError,
  onCancel,
}: OpencodeDeviceLoginProps): React.ReactNode {
  const { baseUrl, billing, label } = OPENCODE_PRODUCTS[product];
  const startedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const [accountLabel, setAccountLabel] = useState<string | undefined>(undefined);

  useKeybinding(
    'confirm:no',
    () => {
      controllerRef.current?.abort();
      onCancel();
    },
    { context: 'Confirmation' },
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    let cancelled = false;

    async function runLogin(): Promise<void> {
      try {
        const device = await requestDeviceCode(OPENCODE_CONSOLE_URL, controller.signal);
        if (cancelled) return;
        onPhase('waiting', device);
        void openBrowser(device.verificationUrl);

        const tokens = await pollForTokens(device, { signal: controller.signal });
        if (cancelled) return;
        onPhase('finishing', device);

        // Best-effort: a token that works for inference must not be rejected
        // because the console declined to describe the account. `fetchAccount`
        // already absorbs each request's own failure, so this only covers an
        // unexpected throw — and the fallback is annotated rather than
        // inferred, since a bare `{}` widens the result and every later
        // `account.orgId` read stops compiling.
        const noAccount: OpencodeAccount = {};
        const account = await fetchAccount(tokens.accessToken, OPENCODE_CONSOLE_URL, controller.signal).catch(
          () => noAccount,
        );
        if (!cancelled) setAccountLabel(describeOpencodeAccount(account));
        await saveOpencodeTokens({
          ...tokens,
          server: OPENCODE_CONSOLE_URL,
          ...account,
        });
        if (cancelled) return;

        const credential = {
          token: tokens.accessToken,
          kind: 'oauth' as const,
          server: OPENCODE_CONSOLE_URL,
          ...(account.orgId ? { orgId: account.orgId } : {}),
        };

        // The entitlement list, which only an OAuth credential has — the paid
        // models an org's plan excludes are exactly the ones it must not be
        // offered, and they would otherwise fail at first use. The base URL
        // goes with it: the public fallback behind that call is per-product,
        // and Zen's 61 models are the wrong answer for a Go subscription.
        const models = await fetchOpencodeModels(credential, baseUrl, controller.signal).catch(() => null);
        if (cancelled) return;

        // Nothing above this line proves the token works HERE. The console
        // minted it for the account, not for a product, and both products serve
        // `/models` publicly — so a Go sign-in by someone who only pays for Zen
        // gets a device code, an account name and a picker full of real ids,
        // and finds out at the first prompt. Verify before activating, so a
        // credential this endpoint refuses fails on the login screen (loud, and
        // Enter retries) instead of becoming a REPL that 401s on everything.
        const probeModel = models?.[0]?.id ?? OPENCODE_PRODUCTS[product].models[0];
        const access = probeModel
          ? await verifyOpencodeAccess(credential, baseUrl, probeModel, controller.signal)
          : ({ ok: true } as const);
        if (cancelled) return;

        // Activation and refusal are one decision, and it is made before the
        // first write rather than after the last one (activateSession.ts).
        const activation = activateOpencodeConsoleSession({
          baseUrl,
          label,
          otherLabel: OPENCODE_PRODUCTS[product === 'go' ? 'zen' : 'go'].label,
          accessToken: tokens.accessToken,
          access,
        });
        if (!activation.activated) {
          onError(activation.message);
          return;
        }

        onReady(
          buildOpencodeModelStep({
            baseUrl,
            models: withLaneLabels(models),
            prefill: prefillTierFields(getSettingsForSource('userSettings')?.modelSettings),
            fetchError: 'the model list could not be read for this account',
          }),
        );
      } catch (err) {
        // An abort is the user pressing Esc, not a failure to report.
        if (cancelled || controller.signal.aborted) return;
        onError((err as Error).message);
      }
    }

    void runLogin();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Runs once: `startedRef` guards a second start, and re-running on a new
    // callback identity would open a second device code the user never asked
    // for while the first is still pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>OpenCode Console Sign-in — {label}</Text>
      <Text dimColor>
        Sign in with your OpenCode account. occ then reaches {label}&apos;s catalog through that account — no API key to
        copy, and the token is stored in occ&apos;s own config directory.
      </Text>
      {/* The account covers both products but the endpoints do not: this login
          configures one of them, and the other one's bill is what a wrong pick
          lands on. */}
      <Text dimColor>
        Endpoint: {baseUrl} · {billing}
      </Text>
      {phase === 'requesting' && (
        <Box>
          <Spinner />
          <Text>Requesting a device code…</Text>
        </Box>
      )}
      {phase !== 'requesting' && grant && (
        <Box flexDirection="column" gap={1}>
          <Text>
            Enter this code: <Text bold>{grant.userCode}</Text>
          </Text>
          <Text>A browser window should have opened. If not, open this link:</Text>
          <Link url={grant.verificationUrl}>
            <Text dimColor>{grant.verificationUrl}</Text>
          </Link>
          {accountLabel && <Text dimColor>Signed in as {accountLabel}</Text>}
          <Box>
            <Spinner />
            <Text>
              {phase === 'waiting' ? 'Waiting for OpenCode authorization…' : 'Reading your account and catalog…'}
            </Text>
          </Box>
        </Box>
      )}
      <Text dimColor>Esc cancels. Device codes expire after 15 minutes.</Text>
    </Box>
  );
}
