import { pairToolEvents } from './pair.ts';
import type { OrphanResult } from './pair.ts';
import type { TraceEvent, TraceEventType } from './types.ts';
import type { ToolStats, TraceStats } from './stats.ts';

// Column widths were picked to line up "tool time" style headers with the
// rest of the summary block, and the table widths were picked so that
// four-digit millisecond values and the "n/a" fallback both fit without
// wrapping.
const LABEL_WIDTH = 14;
const NAME_MIN_WIDTH = 4;
const CALLS_WIDTH = 6;
const FAIL_WIDTH = 6;
const TOTAL_WIDTH = 8;
const AVG_WIDTH = 8;
const MAX_WIDTH = 8;
const SHARE_WIDTH = 7;

const TYPE_ORDER: readonly TraceEventType[] = ['user', 'assistant', 'tool_call', 'tool_result'];

export interface TimelineOptions {
  /** Only show tool_call/tool_result activity for this tool. */
  tool?: string;
  /** Truncate user/assistant text and tool args/output to this many characters. Default 80. */
  maxArgLength?: number;
  /** Set to false to hide user and assistant lines. Default true. */
  includeText?: boolean;
}

/** Render the `stats` summary: totals, per-tool timing, token usage. */
export function renderStats(stats: TraceStats): string {
  const lines: string[] = [];
  const byType = TYPE_ORDER.map((type) => `${type} ${stats.byType[type]}`).join(', ');
  lines.push(`${label('events')}${stats.events}  (${byType})`);

  lines.push(`${label('wall clock')}${stats.wallClockMs === null ? 'n/a' : formatSeconds(stats.wallClockMs)}`);

  const share =
    stats.wallClockMs !== null && stats.wallClockMs > 0
      ? `  (${percent(stats.toolTimeMs / stats.wallClockMs)} of wall clock)`
      : '';
  lines.push(`${label('tool time')}${formatSeconds(stats.toolTimeMs)}${share}`);

  lines.push(
    `${label('tool calls')}${stats.toolCalls}  (${stats.toolCompleted} completed, ${stats.pendingCalls} pending, ` +
      `${stats.toolFailures} failed = ${percent(stats.failureRate)} failure rate)`,
  );

  lines.push(`${label('tokens')}${stats.tokens.input} in / ${stats.tokens.output} out = ${stats.tokens.total} total`);

  if (stats.orphanResults > 0) {
    lines.push(`${label('orphans')}${stats.orphanResults} result(s) could not be matched to a call`);
  }

  if (stats.tools.length > 0) {
    lines.push('', ...renderToolTable(stats.tools));
  }

  return lines.join('\n');
}

function renderToolTable(tools: readonly ToolStats[]): string[] {
  const nameWidth = Math.max(NAME_MIN_WIDTH, ...tools.map((t) => t.name.length));
  const header =
    'tool'.padEnd(nameWidth) +
    'calls'.padStart(CALLS_WIDTH) +
    'fail'.padStart(FAIL_WIDTH) +
    'total'.padStart(TOTAL_WIDTH) +
    'avg'.padStart(AVG_WIDTH) +
    'max'.padStart(MAX_WIDTH) +
    'share'.padStart(SHARE_WIDTH);

  const rows = tools.map((tool) =>
    tool.name.padEnd(nameWidth) +
    String(tool.calls).padStart(CALLS_WIDTH) +
    String(tool.failures).padStart(FAIL_WIDTH) +
    formatDuration(tool.totalMs).padStart(TOTAL_WIDTH) +
    (tool.avgMs === null ? 'n/a' : formatDuration(tool.avgMs)).padStart(AVG_WIDTH) +
    (tool.maxMs === null ? 'n/a' : formatDuration(tool.maxMs)).padStart(MAX_WIDTH) +
    percent(tool.timeShare).padStart(SHARE_WIDTH),
  );

  return [header, ...rows];
}

/** Render the `show` timeline: one line per event, in chronological order. */
export function renderTimeline(events: readonly TraceEvent[], options: TimelineOptions = {}): string {
  const maxArgLength = options.maxArgLength ?? 80;
  const includeText = options.includeText ?? true;
  const toolFilter = options.tool;

  const { spans, orphans } = pairToolEvents(events);
  const spanByCallIndex = new Map(spans.map((span) => [span.callIndex, span]));
  const orphanByIndex = new Map<number, OrphanResult>(orphans.map((orphan) => [orphan.index, orphan]));
  const t0 = events.find((event) => event.ts !== null)?.ts ?? null;

  const lines: string[] = [];

  events.forEach((event, index) => {
    if (event.type === 'tool_result') {
      const orphan = orphanByIndex.get(index);
      if (orphan && !toolFilter) {
        const idPart = orphan.event.id === null ? '' : ` (id ${orphan.event.id})`;
        lines.push(`${stamp(event.ts, t0)}  ! orphan result${idPart}: ${statusOf(orphan.event, orphan.event.durationMs)}`);
      }
      return;
    }

    if (event.type === 'user') {
      if (includeText) lines.push(`${stamp(event.ts, t0)}  user: ${truncate(event.text, maxArgLength)}`);
      return;
    }

    if (event.type === 'assistant') {
      if (!includeText) return;
      const usage = event.usage ? `  (${event.usage.input} in / ${event.usage.output} out)` : '';
      lines.push(`${stamp(event.ts, t0)}  assistant: ${truncate(event.text, maxArgLength)}${usage}`);
      return;
    }

    if (toolFilter && event.name !== toolFilter) return;
    const span = spanByCallIndex.get(index);
    const status = span?.result ? statusOf(span.result, span.durationMs) : 'pending';
    const args = truncate(formatArgs(event.args), maxArgLength);
    lines.push(`${stamp(event.ts, t0)}  ${event.name}(${args})  ${status}`);
  });

  return lines.join('\n');
}

function statusOf(result: { ok: boolean; error: string | null }, durationMs: number | null): string {
  const dur = durationMs === null ? '' : ` ${formatDuration(durationMs)}`;
  if (result.ok) return `ok${dur}`;
  return `failed${dur}${result.error ? `: ${truncate(result.error, 80)}` : ''}`;
}

function formatArgs(args: unknown): string {
  if (args === undefined) return '';
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return String(args);
  }
}

function stamp(ts: number | null, t0: number | null): string {
  if (ts === null || t0 === null) return '[    n/a]';
  return `[${((ts - t0) / 1000).toFixed(3).padStart(7)}s]`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(3)}s` : `${Math.round(ms)}ms`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

function label(text: string): string {
  return text.padEnd(LABEL_WIDTH);
}
