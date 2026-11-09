#!/usr/bin/env node
// Renders the HUD for CLIs with no status line command: reads a session file, builds the stdin
// payload Claude Code would send, and pipes it to hud.mjs. Runs outside the cage, like hud.mjs.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const SOURCES = {
  cursor: { root: path.join(HOME, '.cursor', 'projects'), match: (file) => file.includes('agent-transcripts') },
  codex: { root: path.join(HOME, '.codex', 'sessions'), match: () => true },
};
const CHARS_PER_TOKEN = 4;
const isNumber = Number.isFinite;
const pick = (object, keys) => keys.map((key) => object[key]).find(isNumber);

/** The newest `.jsonl` under root that passes match, or null. */
function newestSession(root, match) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { recursive: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((entry) => entry.endsWith('.jsonl') && match(entry))
    .map((entry) => path.join(root, entry))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }));
  return files.sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null;
}

/** Normalizes one usage object to Anthropic's shape, where input excludes cached tokens. */
function normalizeUsage(node) {
  const input = pick(node, ['input_tokens', 'prompt_tokens']);
  const output = pick(node, ['output_tokens', 'completion_tokens']);
  if (input === undefined || output === undefined) return null;
  if (isNumber(node.cache_read_input_tokens) || isNumber(node.cache_creation_input_tokens)) {
    return {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: node.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: node.cache_read_input_tokens ?? 0,
    };
  }
  const cached = pick(node, ['cached_input_tokens']) ?? pick(node.prompt_tokens_details ?? {}, ['cached_tokens']) ?? 0;
  return { input_tokens: Math.max(0, input - cached), output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cached };
}

/** The per-request usage in a record. Session totals are skipped because they never shrink. */
function findUsage(node) {
  if (!node || typeof node !== 'object') return null;
  const usage = Array.isArray(node) ? null : normalizeUsage(node);
  if (usage) return usage;
  for (const [key, value] of Object.entries(node)) {
    if (/^(total|cumulative)/i.test(key)) continue;
    const found = findUsage(value);
    if (found) return found;
  }
  return null;
}

function messageChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + (block?.text?.length ?? 0) + (block?.input ? JSON.stringify(block.input).length : 0), 0);
}

const contextOf = (usage) => usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;

/** Reduces JSONL records to context history, last usage, and throughput; estimates when no usage is logged. */
export function summarize(text) {
  const history = [];
  const usages = [];
  let chars = 0;
  let previousAt = null;
  let tokPerSec = null;

  for (const raw of text.split('\n')) {
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    const usage = findUsage(record);
    if (usage && contextOf(usage) > 0) {
      usages.push(usage);
      history.push(contextOf(usage));
      const at = Date.parse(record.timestamp);
      // Wall clock between requests, so tool time drags this down. It is shown as an estimate.
      if (isNumber(at) && previousAt !== null && at > previousAt) tokPerSec = usage.output_tokens / ((at - previousAt) / 1000);
      if (isNumber(at)) previousAt = at;
    }
    chars += messageChars(record.message?.content);
    if (record.role === 'assistant') history.push(Math.round(chars / CHARS_PER_TOKEN));
  }

  const usage = usages.at(-1) ?? null;
  if (usage) {
    const measured = usages.map(contextOf);
    const reads = usages.reduce((sum, item) => sum + item.cache_read_input_tokens, 0);
    return { usage, history: measured, systemTokens: measured[0], tokPerSec, hitRatio: reads / measured.reduce((a, b) => a + b, 0), estimated: true };
  }
  const estimate = Math.round(chars / CHARS_PER_TOKEN);
  return {
    usage: { input_tokens: estimate, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    history,
    systemTokens: null,
    tokPerSec: null,
    hitRatio: null,
    estimated: true,
  };
}

const parseSize = (value) => {
  const match = /^(\d+(?:\.\d+)?)(k|m)$/i.exec(String(value ?? ''));
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1e3 : 1e6) : undefined;
};

/** The model, effort, and context size Cursor's CLI config records for its selected model. */
export function cursorModel(config) {
  const id = config.selectedModel?.modelId ?? config.model?.modelId;
  const parameters = [...(config.selectedModel?.parameters ?? []), ...(config.modelParameters?.[id] ?? [])];
  const value = (name) => parameters.find((parameter) => parameter.id === name)?.value;
  return { id, displayName: config.model?.modelId === id ? config.model.displayName : id, effort: value('effort') ?? value('reasoning'), size: parseSize(value('context')) };
}

function readCursorModel() {
  try {
    return cursorModel(JSON.parse(fs.readFileSync(path.join(HOME, '.cursor', 'cli-config.json'), 'utf8')));
  } catch {
    return {};
  }
}

export function toPayload(summary, model, cwd) {
  return {
    cwd,
    model: { id: model.id ?? 'unknown', display_name: model.displayName ?? model.id ?? 'Unknown' },
    context_window: { current_usage: summary.usage, ...(model.size ? { context_window_size: model.size } : {}) },
    ...(model.effort ? { effort: { level: model.effort } } : {}),
    ...(summary.hitRatio === null ? {} : { prompt_cache: { hit_ratio: summary.hitRatio } }),
    hud_context: { system_tokens: summary.systemTokens, history: summary.history, tok_per_sec: summary.tokPerSec, estimated: summary.estimated },
  };
}

function parseArgs(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  return { cli: value('--cli'), file: value('--file'), json: argv.includes('--json'), watch: argv.includes('--watch') };
}

function renderOnce({ cli, file, json }) {
  const source = SOURCES[cli];
  const session = file ?? (source && newestSession(source.root, source.match));
  if (!session) {
    process.stderr.write(`No session found. Use --cli ${Object.keys(SOURCES).join('|')} or --file <path.jsonl>.\n`);
    return false;
  }
  const payload = JSON.stringify(toPayload(summarize(fs.readFileSync(session, 'utf8')), cli === 'cursor' ? readCursorModel() : {}, process.cwd()));
  if (json) {
    process.stdout.write(`${payload}\n`);
    return true;
  }
  return spawnSync(process.execPath, [fileURLToPath(new URL('../hud.mjs', import.meta.url))], { input: payload, stdio: ['pipe', 'inherit', 'inherit'] }).status === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.watch) {
    const draw = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      renderOnce(args);
    };
    draw();
    setInterval(draw, 2000);
  } else {
    process.exitCode = renderOnce(args) ? 0 : 1;
  }
}
