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
 *
 * ── Where a Console token is actually accepted ──
 *
 * Not at either product. That was the bug this screen carried: it minted a
 * token and pointed the session at a constant, and every request came back
 * `API Error [OpenAI]: Invalid API key. status=401`. Measured on one account
 * with one token (2026-08-11):
 *
 *   POST {config.provider.opencode.api}/chat/completions   200, real completion
 *   POST https://opencode.ai/zen/v1/chat/completions        401 AuthError
 *
 * So the endpoint is READ from `GET {console}/api/config`, together with the
 * headers it says the provider needs (`x-org-id`, per account) and the org's
 * entitlement models. That plane is OpenAI-compatible and nothing else —
 * `/messages` there answers 404 — so the session is marked
 * `OPENCODE_INFERENCE_PLANE=console` and the lane heuristic is skipped
 * entirely. The product prop still decides the fallback endpoint for a console
 * that describes no provider, and still names the billing copy on screen.
 */

import { Box, Link, Text } from '@anthropic/ink';
import React, { useEffect, useRef, useState } from 'react';
import { useKeybinding } from 'src/keybindings/useKeybinding.js';
import {
  type DeviceCodeGrant,
  fetchAccount,
  fetchOpencodeConsoleConfig,
  fetchZenModels,
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
  // Starts as the product the user picked and is replaced the moment
  // `/api/config` names the account's own inference proxy. The line on screen
  // has to say where requests will really go: for a Console account that is the
  // console's endpoint, and the product URL shown until then is not it.
  const [shownEndpoint, setEndpoint] = useState(baseUrl);

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

        // `/api/config` is asked before anything is stored, because it decides
        // where this session's requests go. A Console token is NOT a credential
        // for the Zen gateway — measured on one account, side by side: 200 with
        // a real completion at `config.provider.opencode.api`, and 401
        // `AuthError: Invalid API key.` at https://opencode.ai/zen/v1. The
        // endpoint, the required headers (`x-org-id`, per account, so never a
        // constant) and the entitlement models all come out of this one answer,
        // exactly as sst/opencode's own provider plugin reads them.
        const config = await fetchOpencodeConsoleConfig(
          {
            token: tokens.accessToken,
            kind: 'oauth',
            server: OPENCODE_CONSOLE_URL,
            // Only the org id: `email` and `orgName` are display fields, and a
            // credential is the wrong place to carry them.
            ...(account.orgId ? { orgId: account.orgId } : {}),
          },
          controller.signal,
        ).catch(() => null);
        if (cancelled) return;

        // No provider in the console's answer means no Console inference plane
        // to point at, so the session falls back to the product the user chose
        // and to the Zen/Go lane rules. The probe below still decides whether
        // that fallback is usable — it is not assumed to be.
        const inference = config?.inference;
        const endpoint = inference?.api ?? baseUrl;
        const plane = inference ? ('console' as const) : undefined;
        if (!cancelled) setEndpoint(endpoint);

        const credential = {
          token: tokens.accessToken,
          kind: 'oauth' as const,
          server: OPENCODE_CONSOLE_URL,
          ...(account.orgId ? { orgId: account.orgId } : {}),
          ...(inference?.headers ? { headers: inference.headers } : {}),
        };

        await saveOpencodeTokens({
          ...tokens,
          server: OPENCODE_CONSOLE_URL,
          ...account,
          // Stored with the account rather than with the token: refreshing
          // answers with tokens alone, so a plane kept beside the access token
          // would be gone an hour into the session.
          ...(inference ? { inference } : {}),
        });
        if (cancelled) return;

        // The entitlement list, which only an OAuth credential has — the paid
        // models an org's plan excludes are exactly the ones it must not be
        // offered, and they would otherwise fail at first use. Falling back to
        // the endpoint's public catalog rather than re-asking the console,
        // which has already answered above.
        const models =
          config?.models ?? (await fetchZenModels(endpoint, credential, controller.signal).catch(() => null));
        if (cancelled) return;

        // Nothing above this line proves the token works HERE. The console
        // minted it for the account, not for a product, and both products serve
        // `/models` publicly — so a Go sign-in by someone who only pays for Zen
        // gets a device code, an account name and a picker full of real ids,
        // and finds out at the first prompt. Verify before activating, so a
        // credential this endpoint refuses fails on the login screen (loud, and
        // Enter retries) instead of becoming a REPL that 401s on everything.
        // Probed at `endpoint`, never at the product constant: those are
        // different hosts for a Console session and the token only works at one.
        const probeModel = models?.[0]?.id ?? (plane ? undefined : OPENCODE_PRODUCTS[product].models[0]);
        const access = probeModel
          ? await verifyOpencodeAccess(credential, endpoint, probeModel, controller.signal)
          : ({ ok: true } as const);
        if (cancelled) return;

        // Activation and refusal are one decision, and it is made before the
        // first write rather than after the last one (activateSession.ts).
        const activation = activateOpencodeConsoleSession({
          baseUrl: endpoint,
          label,
          otherLabel: OPENCODE_PRODUCTS[product === 'go' ? 'zen' : 'go'].label,
          accessToken: tokens.accessToken,
          ...(plane ? { plane } : {}),
          access,
        });
        if (!activation.activated) {
          onError(activation.message);
          return;
        }

        onReady(
          buildOpencodeModelStep({
            baseUrl: endpoint,
            // Lane suffixes describe a Zen/Go pick. On the Console plane every
            // id lands on the same `/chat/completions`, so annotating them with
            // `/messages` would advertise a path that answers 404 there.
            models: plane ? models : withLaneLabels(models),
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
        Endpoint: {shownEndpoint} · {billing}
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
