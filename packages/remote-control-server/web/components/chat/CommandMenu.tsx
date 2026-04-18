import { useMemo, useRef, useEffect } from "react";
import {
  Command,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "../ui/command";
import { cn } from "../../src/lib/utils";
import type { AvailableCommand } from "../../src/acp/types";

// =============================================================================
// Slash command picker — floating above ChatInput
// =============================================================================

interface CommandMenuProps {
  commands: AvailableCommand[];
  /** Text after "/" used for filtering */
  filter: string;
  onSelect: (command: AvailableCommand) => void;
  onClose: () => void;
  className?: string;
}

/**
 * Fuzzy match — checks if all query chars appear in order in the text.
 * Same algorithm as ModelSelectorPicker.
 */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  let queryIdx = 0;
  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      queryIdx++;
    }
  }
  return queryIdx === lowerQuery.length;
}

export function CommandMenu({
  commands,
  filter,
  onSelect,
  onClose,
  className,
}: CommandMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Filter commands by current input
  const filtered = useMemo(() => {
    if (!filter) return commands;
    return commands.filter(
      (cmd) => fuzzyMatch(filter, cmd.name) || fuzzyMatch(filter, cmd.description),
    );
  }, [commands, filter]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "rounded-xl border border-border bg-surface-2 shadow-lg",
        className,
      )}
    >
      <Command shouldFilter={false}>
        <CommandList className="max-h-[320px]">
          <CommandEmpty className="text-xs text-text-muted font-display py-3">
            没有匹配的命令
          </CommandEmpty>
          <CommandGroup>
            {filtered.map((cmd) => (
              <CommandItem
                key={cmd.name}
                value={cmd.name}
                onSelect={() => onSelect(cmd)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 cursor-pointer",
                  "rounded-lg mx-1",
                  "data-[selected=true]:bg-brand/8 data-[selected=true]:text-text-primary",
                )}
              >
                <span className="text-sm font-display font-medium text-brand">
                  /{cmd.name}
                </span>
                <span className="text-xs text-text-muted truncate flex-1">
                  {cmd.description}
                </span>
                {cmd.input?.hint && (
                  <span className="text-[10px] text-text-muted italic">
                    {cmd.input.hint}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
