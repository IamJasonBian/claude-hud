import { formatBytes } from '../memory.ts';
import { t } from '../i18n/index.ts';
import { displayLabel } from '../utils/sanitize.ts';
import type { Frame } from './frame.ts';
import { critical, dim, getContextColor, getQuotaColor, label, quotaBar, RESET, warning } from './colors.ts';
import { effort, outputStyle } from './derive.ts';
import { formatEffort } from '../effort.ts';
import { getTotalTokens } from '../stdin.ts';
import { formatTokens } from '../utils/format.ts';
import { barLabel, type LabelAlign } from './labels.ts';
import { addedDirs, configCountParts } from './parts.ts';
import { formatAbsoluteTime, formatAgo, wallClock } from './time.ts';

const MAX_NAMED_MCP_ERRORS = 3;
const MCP_NAME_MAX = 64;

/** `⚠ github, tenable +2`. */
function mcpErrors(f: Frame, names: string[]): string {
  const safe = names.map((name) => displayLabel(name, MCP_NAME_MAX)).filter(Boolean);
  const overflow = safe.length > MAX_NAMED_MCP_ERRORS ? ` +${safe.length - MAX_NAMED_MCP_ERRORS}` : '';
  return critical(`⚠ ${safe.slice(0, MAX_NAMED_MCP_ERRORS).join(', ')}${overflow}`, f.config?.colors);
}

/** Config counts, output style, and failing MCP servers. */
export function environmentLine(f: Frame): string | null {
  const display = f.config?.display;
  const showErrors = display?.showConfigCounts === true || display?.showMcp === true;
  const failing = showErrors ? f.transcript?.mcpErrors ?? [] : [];
  const errors = failing.length > 0 ? mcpErrors(f, failing) : '';
  const parts = configCountParts(f, errors ? ` ${errors}` : '');
  const countedMcp = parts.length > 0 && f.mcpCount > 0;
  const style = display?.showOutputStyle === true ? outputStyle(f) : undefined;
  if (style) parts.push(label(`style: ${style}`, f.config?.colors));
  if (errors && !countedMcp) parts.push(errors);
  return parts.length > 0 ? parts.join(' | ') : null;
}

const TTL_SECONDS: Record<string, number> = { '5m': 300, '1h': 3600 };

// Shows the expiry time rather than a countdown: between turns, exactly when the cache
// drains, the statusline isn't repainted and a countdown would freeze.
export function promptCacheLine(f: Frame): string | null {
  const display = f.config?.display;
  const cache = f.stdin.prompt_cache;
  if (!display?.showPromptCache || !cache?.caching_observed) return null;

  const colors = f.config?.colors;
  const expiresAtMs = typeof cache.expires_at === 'number' ? cache.expires_at * 1000 : 0;
  const remainingMs = cache.warm ? expiresAtMs - f.now : 0;
  let value: string;
  if (remainingMs <= 0) {
    value = label(`⏱ ${t('status.expired')}`, colors);
  } else {
    const warnMs = Math.max(60, Math.floor((TTL_SECONDS[cache.ttl ?? ''] ?? 300) / 5)) * 1000;
    const until = `⏱ ${formatAbsoluteTime(new Date(expiresAtMs), new Date(f.now), wallClock(display), 'format.untilTime')}`;
    value = remainingMs <= warnMs ? warning(until, colors) : `${getContextColor(0, colors)}${until}${RESET}`;
  }
  return `${label(t('label.promptCache'), colors)} ${value}`;
}

export function cacheHitRateLine(f: Frame): string | null {
  const ratio = f.stdin.prompt_cache?.hit_ratio;
  if (f.config?.display?.showCacheHitRate !== true || typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  return `${label(t('label.cacheHitRate'), f.config?.colors)} ${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
}

const SPARK = '▁▂▃▄▅▆▇█';
const SPARK_WIDTH = 12;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function sparkline(values: number[]): string {
  const shown = values.slice(-SPARK_WIDTH);
  const max = Math.max(...shown, 1);
  return shown.map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor((value / max) * SPARK.length))]).join('');
}

function cacheRatio(f: Frame): number | null {
  const ratio = f.stdin.prompt_cache?.hit_ratio;
  if (typeof ratio === 'number' && Number.isFinite(ratio)) return ratio;
  const tokens = f.transcript.sessionTokens;
  const total = tokens ? tokens.inputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens : 0;
  return tokens && total > 0 ? tokens.cacheReadTokens / total : null;
}

/** `sys 31k · local 142k ▂▃▅▇ │ ◑ high │ 52.1 tok/s │ cache 96%`; `~` marks estimates. */
export function contextHistoryLine(f: Frame): string | null {
  const adapter = f.stdin.hud_context;
  if (!f.config?.display?.showContextHistory && !adapter) return null;

  const history = (adapter?.history ?? f.transcript.contextHistory ?? []).filter(isCount);
  const current = getTotalTokens(f.stdin) || f.transcript.contextTokens || history.at(-1) || 0;
  if (current === 0) return null;

  const mark = adapter?.estimated ? '~' : '';
  const system = adapter ? adapter.system_tokens : f.transcript.systemTokens;
  const split = isCount(system)
    ? `sys ${mark}${formatTokens(system)} · local ${mark}${formatTokens(Math.max(0, current - system))}`
    : `local ${mark}${formatTokens(current)}`;
  const info = effort(f);
  const speed = adapter ? adapter.tok_per_sec : f.outputSpeed;
  const ratio = cacheRatio(f);
  const parts = [
    history.length > 1 ? `${split} ${sparkline(history)}` : split,
    info ? formatEffort(info, f.config?.display?.effortFormat) : null,
    isCount(speed) ? `${mark}${speed.toFixed(1)} ${t('format.tokPerSec')}` : null,
    ratio !== null ? `${t('format.cache')} ${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` : null,
  ].filter(Boolean);
  return label(parts.join(' │ '), f.config?.colors);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `Started: 2026-10-01 11:00 │ Last reply: 1m ago`. */
export function sessionTimeLine(f: Frame): string | null {
  const display = f.config?.display;
  const colors = f.config?.colors;
  const parts: string[] = [];
  const start = f.transcript.sessionStart;
  if (display?.showSessionStartDate === true && start) {
    const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:${pad(start.getMinutes())}`;
    parts.push(`${label(`${t('label.sessionStarted')}:`, colors)} ${date}`);
  }
  const lastReply = f.transcript.lastAssistantResponseAt;
  if (display?.showLastResponseAt === true && lastReply) {
    parts.push(`${label(`${t('label.lastReply')}:`, colors)} ${formatAgo(f.now - lastReply.getTime())}`);
  }
  return parts.length > 0 ? parts.join(` ${label('│', colors)} `) : null;
}

/** Approximate system RAM (expanded only). */
export function memoryLine(f: Frame, align: LabelAlign = {}): string | null {
  const memory = f.memoryUsage;
  if (f.config?.lineLayout !== 'expanded' || f.config?.display?.showMemoryUsage !== true || !memory) return null;
  const colors = f.config?.colors;
  const prefix = barLabel('label.approxRam', colors, { ...align, includeMemoryInWidth: true });
  const percent = `${getQuotaColor(memory.usedPercent, colors)}${memory.usedPercent}%${RESET}`;
  const bar = quotaBar(memory.usedPercent, f.barWidth, colors);
  return `${prefix} ${bar} ${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)} (${percent})`;
}

/** Added dirs on their own line, when addedDirsLayout is "line". */
export function addedDirsLine(f: Frame): string | null {
  const display = f.config?.display;
  if (display?.showAddedDirs === false || (display?.addedDirsLayout ?? 'inline') !== 'line') return null;
  const dirs = addedDirs(f, '', dim(', '));
  return dirs ? `${label('Added dirs:', f.config?.colors)} ${dirs}` : null;
}
