// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
//
// Shared by the root program and by every subcommand group that wants its
// own sorted help (mcp, auth, plugin, marketplace).
import type { Option } from '@commander-js/extra-typings';

// Create help config that sorts options by long option name.
// Commander supports compareOptions at runtime but @commander-js/extra-typings
// doesn't include it in the type definitions, so we use Object.assign to add it.
export function createSortedHelpConfig(): {
  sortSubcommands: true;
  sortOptions: true;
} {
  const getOptionSortKey = (opt: Option): string => opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
  return Object.assign({ sortSubcommands: true, sortOptions: true } as const, {
    compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b)),
  });
}
