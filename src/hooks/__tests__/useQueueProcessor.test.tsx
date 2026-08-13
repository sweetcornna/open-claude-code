import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import * as React from 'react';
import { QueryGuard } from '../../utils/session/QueryGuard.js';
import { enqueue, resetCommandQueue } from '../../utils/session/messageQueueManager.js';
import { useQueueProcessor } from '../useQueueProcessor.js';

const { wrappedRender: render } = await import('@anthropic/ink');

beforeEach(() => {
  resetCommandQueue();
});

afterEach(() => {
  resetCommandQueue();
});

describe('useQueueProcessor', () => {
  test('runs queued input as soon as the active query ends', async () => {
    const queryGuard = new QueryGuard();
    const generation = queryGuard.tryStart();
    if (generation === null) throw new Error('failed to start query guard');

    let resolveExecuted: (() => void) | undefined;
    const executed = new Promise<void>(resolve => {
      resolveExecuted = resolve;
    });
    const received: string[][] = [];

    function Probe(): React.ReactNode {
      useQueueProcessor({
        queryGuard,
        hasActiveLocalJsxUI: false,
        executeQueuedInput: async commands => {
          received.push(commands.map(command => command.value as string));
          resolveExecuted?.();
        },
      });
      return null;
    }

    const output = new PassThrough();
    output.resume();
    const input = new PassThrough();
    const instance = await render(<Probe />, {
      stdout: output as unknown as NodeJS.WriteStream,
      stdin: input as unknown as NodeJS.ReadStream,
      stderr: output as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    try {
      enqueue({ value: 'queued while running', mode: 'prompt' });
      await Promise.resolve();
      expect(received).toEqual([]);

      expect(queryGuard.end(generation)).toBe(true);
      await Promise.race([
        executed,
        new Promise<never>((_, reject) =>
          setTimeout(reject, 1_000, new Error('queued input did not run after the query ended')),
        ),
      ]);

      expect(received).toEqual([['queued while running']]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });
});
