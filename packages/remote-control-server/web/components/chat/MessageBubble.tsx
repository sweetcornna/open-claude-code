import type { UserMessageEntry, AssistantMessageEntry, UserMessageImage } from "../../src/lib/types";
import { cn, esc } from "../../src/lib/utils";
import { MessageResponse } from "../ai-elements/message";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "../ai-elements/reasoning";

// =============================================================================
// 用户消息 — 右对齐，深色反转背景，无气泡边框
// Anthropic: right-aligned, inverted dark bg, rounded-xl with bottom-right notch
// =============================================================================

interface UserBubbleProps {
  entry: UserMessageEntry;
}

export function UserBubble({ entry }: UserBubbleProps) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] sm:max-w-[75%]">
        {/* 图片附件 */}
        {entry.images && entry.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 justify-end">
            {entry.images.map((img, i) => (
              <ImageThumbnail key={i} image={img} />
            ))}
          </div>
        )}
        {/* 文本内容 */}
        {entry.content && (
          <div className="rounded-2xl rounded-br-md bg-bg-inverted px-4 py-2.5 text-sm text-text-inverted whitespace-pre-wrap font-display leading-relaxed">
            {esc(entry.content)}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 助手消息 — 左对齐，无背景卡片，编辑式排版
// Anthropic: avatar + plain text, no bubble/card wrapper, serif body font
// =============================================================================

interface AssistantBubbleProps {
  entry: AssistantMessageEntry;
  isStreaming?: boolean;
}

export function AssistantBubble({ entry, isStreaming }: AssistantBubbleProps) {
  return (
    <div className="flex gap-3 items-start">
      {/* Orange triangle avatar */}
      <div className="w-7 h-7 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 2L12 12H2L7 2Z" fill="var(--color-brand)" opacity=".85" />
        </svg>
      </div>
      {/* 内容 — 无卡片背景，直接排版 */}
      <div className="flex-1 min-w-0 space-y-3">
        {/* Sender label */}
        <span className="text-sm font-medium text-text-primary font-display">Claude</span>
        {entry.chunks.map((chunk, i) => {
          if (chunk.type === "thought") {
            const isLastChunk = i === entry.chunks.length - 1;
            const isThoughtStreaming = isStreaming && isLastChunk;
            return (
              <Reasoning key={i} isStreaming={isThoughtStreaming}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <div className="text-sm text-text-secondary">
                    {chunk.text}
                  </div>
                </ReasoningContent>
              </Reasoning>
            );
          }
          // 普通消息块 — 直接输出，无包裹卡片
          return (
            <div key={i} className="message-content text-text-primary leading-loose">
              <MessageResponse>{chunk.text}</MessageResponse>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// 图片缩略图 — 点击放大
// =============================================================================

function ImageThumbnail({ image }: { image: UserMessageImage }) {
  const dataUrl = `data:${image.mimeType};base64,${image.data}`;
  return (
    <button
      type="button"
      className="rounded-lg overflow-hidden border border-border hover:border-brand/40 transition-colors cursor-pointer"
      onClick={() => {
        // 简单的点击放大 — 在新标签页打开图片
        const w = window.open("");
        if (w) {
          w.document.write(`<img src="${dataUrl}" style="max-width:100%;max-height:100%" />`);
        }
      }}
    >
      <img
        src={dataUrl}
        alt="用户上传的图片"
        className="h-20 w-20 object-cover"
      />
    </button>
  );
}
