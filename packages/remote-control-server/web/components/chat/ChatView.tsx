import type { ThreadEntry, ToolCallEntry } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { UserBubble, AssistantBubble } from "./MessageBubble";
import { ToolCallGroup } from "./ToolCallGroup";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButtons } from "../ai-elements/conversation";

// =============================================================================
// 统一聊天视图 — Anthropic 编辑式排版
// 无气泡间距，用垂直 rhythm 区分消息块
// =============================================================================

interface ChatViewProps {
  entries: ThreadEntry[];
  isLoading?: boolean;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function ChatView({
  entries,
  isLoading = false,
  onPermissionRespond,
  emptyTitle = "开始对话",
  emptyDescription = "输入消息开始聊天",
}: ChatViewProps) {
  // 将相邻的 ToolCallEntry 合并为一组
  const grouped = groupToolCalls(entries);
  const hasMessages = entries.length > 0;

  // 检查是否正在加载（最后一个条目是用户消息）
  const showThinking = isLoading && entries.length > 0 && entries[entries.length - 1]?.type === "user_message";

  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {!hasMessages ? (
          <ConversationEmptyState
            title={emptyTitle}
            description={emptyDescription}
          />
        ) : (
          <>
            {grouped.map((item, i) => {
              if (item.type === "single") {
                return (
                  <div key={`entry-${i}`} className={cn(entrySpacing(entries, i))}>
                    <EntryRenderer entry={item.entry} isLoading={isLoading} onPermissionRespond={onPermissionRespond} />
                  </div>
                );
              }
              // 工具调用组 — 紧贴在助手消息下方
              return (
                <div key={`group-${i}`} className="-mt-2">
                  <ToolCallGroup entries={item.entries} onPermissionRespond={onPermissionRespond} />
                </div>
              );
            })}

            {/* 思考指示器 — Anthropic 打字动画 */}
            {showThinking && (
              <div className="flex gap-3 items-start">
                <div className="w-7 h-7 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M7 2L12 12H2L7 2Z" fill="var(--color-brand)" opacity=".85" />
                  </svg>
                </div>
                <div className="flex items-center gap-1 pt-1">
                  <span className="chat-typing-indicator" aria-hidden="true">
                    <span></span><span></span><span></span>
                  </span>
                </div>
              </div>
            )}
          </>
        )}
        <ConversationScrollButtons hasUserMessages={entries.some((e) => e.type === "user_message")} />
      </ConversationContent>
    </Conversation>
  );
}

// =============================================================================
// 间距逻辑 — 用户消息前后间距大，工具调用紧贴
// =============================================================================

function entrySpacing(entries: ThreadEntry[], index: number): string {
  const entry = entries[index];
  // 用户消息前面多留白
  if (entry?.type === "user_message") {
    return "pt-6 pb-2";
  }
  // 助手消息后面多留白（除非紧跟工具调用）
  if (entry?.type === "assistant_message") {
    const next = entries[index + 1];
    if (next?.type === "tool_call") {
      return "pt-2 pb-1";
    }
    return "pt-2 pb-4";
  }
  return "py-1";
}

// =============================================================================
// 单条目渲染器
// =============================================================================

function EntryRenderer({
  entry,
  isLoading,
  onPermissionRespond,
}: {
  entry: ThreadEntry;
  isLoading: boolean;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
}) {
  switch (entry.type) {
    case "user_message":
      return <UserBubble entry={entry} />;
    case "assistant_message":
      return <AssistantBubble entry={entry} isStreaming={isLoading} />;
    case "tool_call":
      return (
        <ToolCallGroup
          entries={[entry as ToolCallEntry]}
          onPermissionRespond={onPermissionRespond}
        />
      );
    default:
      return null;
  }
}

// =============================================================================
// 工具调用分组逻辑
// =============================================================================

type GroupedItem =
  | { type: "single"; entry: ThreadEntry }
  | { type: "tool_group"; entries: ToolCallEntry[] };

function groupToolCalls(entries: ThreadEntry[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let currentToolGroup: ToolCallEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length === 1) {
      result.push({ type: "single", entry: currentToolGroup[0] });
    } else if (currentToolGroup.length > 1) {
      result.push({ type: "tool_group", entries: currentToolGroup });
    }
    currentToolGroup = [];
  };

  for (const entry of entries) {
    if (entry.type === "tool_call") {
      currentToolGroup.push(entry);
    } else {
      flushToolGroup();
      result.push({ type: "single", entry });
    }
  }
  flushToolGroup();

  return result;
}
