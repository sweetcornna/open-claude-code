import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as React from 'react';
import { resetStateForTests, setCwdState, setOriginalCwd } from '../../bootstrap/state.js';
import { getIsGit } from '../../utils/git/git.js';
import { useDiffData } from '../useDiffData.js';

const { wrappedRender: render } = await import('@anthropic/ink');

let testDir: string | null = null;
let previousCwd = process.cwd();

beforeEach(() => {
  previousCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(previousCwd);
  resetStateForTests();
  getIsGit.cache.clear?.();
  if (testDir) await rm(testDir, { recursive: true, force: true });
  testDir = null;
});

describe('useDiffData live refresh', () => {
  test('shows a diff created while the dialog hook remains mounted', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'occ-diff-refresh-'));
    execFileSync('git', ['init', '-q'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: testDir,
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    await writeFile(join(testDir, 'tracked.txt'), 'before\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: testDir });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: testDir });

    process.chdir(testDir);
    setOriginalCwd(testDir);
    setCwdState(testDir);
    getIsGit.cache.clear?.();

    let resolveInitial: (() => void) | null = null;
    const initial = new Promise<void>(resolve => {
      resolveInitial = resolve;
    });
    let resolveWatcherReady: (() => void) | null = null;
    const watcherReady = new Promise<void>(resolve => {
      resolveWatcherReady = resolve;
    });
    let cleanRefreshes = 0;
    let resolveRefresh: (() => void) | null = null;
    const refreshed = new Promise<void>(resolve => {
      resolveRefresh = resolve;
    });

    function Probe(): React.ReactNode {
      const data = useDiffData();
      React.useEffect(() => {
        if (!data.loading) {
          resolveInitial?.();
          if (data.files.length === 0) {
            cleanRefreshes++;
            if (cleanRefreshes >= 2) resolveWatcherReady?.();
          }
        }
        if (data.files.some(file => file.path === 'tracked.txt')) {
          resolveRefresh?.();
        }
      }, [data]);
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
      await Promise.race([
        initial,
        new Promise<never>((_, reject) => setTimeout(reject, 5000, new Error('initial diff did not load'))),
      ]);
      await Promise.race([
        watcherReady,
        new Promise<never>((_, reject) => setTimeout(reject, 5000, new Error('diff watcher did not become ready'))),
      ]);
      await writeFile(join(testDir, 'tracked.txt'), 'after\n');
      await Promise.race([
        refreshed,
        new Promise<never>((_, reject) => setTimeout(reject, 5000, new Error('diff did not refresh'))),
      ]);
      expect(true).toBe(true);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });
});
