# 长会话内存占用

occ 是单进程长驻的。默认堆上限由 Node 决定（多数 64 位机器约 4GB），一旦触顶就是硬崩：

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed
```

「Ineffective mark-compacts」是关键词：它表示 GC 跑了但几乎没回收到东西（实测那次 4074.9 → 4067.3 MB，7MB），**说明是真实驻留而不是 GC 压力**。这类崩溃只能靠减少驻留来修，调大 `--max-old-space-size` 只是把时间推后。

## 已修：子 agent 的 progress 轨迹（2.34.0）

子 agent 产生的**每一条**消息都会被包成一条 `agent_progress` 追加进**父会话**的 `messages` 数组。这不是疏忽：bash/mcp 的 tick 是就地替换的，而 agent 的轨迹必须完整保留，否则运行中的 AgentTool 那一行会卡在「Initializing…」（`REPL.tsx` 里那段注释就是讲这个）。

问题在于**没有任何东西移除它们**。于是父会话累积了它跑过的所有子 agent 的全部内容。

一次真实崩溃的数据：

| | |
| --- | --- |
| 子 agent 数 | 216 |
| 单个 agent 最多 | 1,270 条 assistant 消息 / 1,269 次工具调用 |
| 子 agent transcript 总量 | 63.7 MB |
| 主 transcript | 9.0 MB（1,406 行） |
| 崩溃时堆 | ~4 GB |

主 transcript 只有 9MB 而堆到 4GB，正是因为 progress 消息**不落盘**（`isLoggableMessage` 对它们返回 false）—— 内存里那 27 万条的对应物在磁盘上是各 agent 自己的 `subagents/agent-<id>.jsonl`，主会话这边看不见。再叠上 `normalizedMessages` 平行副本、`progressMessagesByToolUseID` 索引和 Ink 为每一行保留的渲染树，4GB 就是这么来的。

**修法**：agent 的 `tool_result` 到达时，把它那条轨迹裁到只剩尾部若干条（`src/utils/messages/pruneAgentProgress.ts`）。

- **只在 agent 结束时裁，运行中一律不动** —— 实时渲染字节级不变。
- 结束后的 agent 走 `renderToolResultMessage`，计数和摘要取自 tool result 本身，不读这条轨迹。只有 transcript 模式（Ctrl+R）会走它，而那些内容在 `subagents/agent-<id>.jsonl` 里是完整的。
- **保留尾部而不是全删**：短于阈值的 agent 完全不受影响（绝大多数情况零行为变化），长的被裁时留下的是「它怎么结束的」——人回头看的就是这段。
- 数组永远不动 index 0：`useLogMessages` 靠 `messages[0].uuid` 区分「同头缩短」和 compaction，换头会走到另一条 transcript 父链重建逻辑上去。

`CLAUDE_CODE_AGENT_PROGRESS_RETAIN` 调节保留条数，默认 20；设 `0` 表示结束即全丢，设很大的值等于恢复旧的全留行为。

## 内存预警与堆快照

`useMemoryUsage` 每 10 秒采样一次堆。跨过 1.5 / 2.5 / 3.5 GB 时各记录一条日志（`src/utils/telemetry/autoHeapDump.ts`），带 heapUsed / rss / external 和**增长速率**（MB/h）——判断「是不是漏」主要看这个速率。

`CLAUDE_CODE_AUTO_HEAP_DUMP=1` 才会额外写 `.heapsnapshot`（每会话最多 2 份，落在桌面）。默认不写：序列化一个数 GB 的堆会产生同等大小的文件并让进程卡住数秒，不该在用户已经很难受的时候不打招呼就干。

此前 `heapDumpService` 的 `auto-1.5GB` trigger 是**没有调用方的死代码**，所以上面那次 4GB 崩溃什么证据都没留下，只能事后从 transcript 反推。

## 其余相关取舍

- **后台任务驱逐**原本只在主线程的 attachment 阶段跑，子 agent 轮次从不清扫；一个主线程轮次里连开上百个 agent 时整轮零次清扫。现在终态任务自己排一个 unref 定时器（`scheduleTerminalTaskEviction`）。见 `src/utils/task/framework.ts`。
- **大工具结果**超过阈值（默认 50k 字符）落盘并在消息里替换成引用，见 `src/utils/tools/toolResultStorage.ts`。
- **文件检查点**上限 20 个快照，且备份是磁盘文件名而非内容（`src/utils/filesystem/fileHistory.ts`）。
