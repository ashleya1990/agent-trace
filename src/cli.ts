#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatIssue, parseTrace } from './parse.ts';
import { computeStats } from './stats.ts';
import { renderStats, renderTimeline } from './render.ts';
import type { TimelineOptions } from './render.ts';

const USAGE = `agent-trace -- summarise and replay agent tool-call traces

Usage:
  agent-trace stats <file> [--json] [--strict]
  agent-trace show <file> [--tool=<name>] [--max-arg=<n>] [--no-text] [--strict]
  agent-trace -h | --help
  agent-trace --version

Pass - as <file> to read the trace from stdin.

Options:
  --json          print stats as JSON instead of a table (stats only)
  --tool=<name>   restrict show to a single tool
  --max-arg=<n>   truncate tool arguments to n characters (default 80)
  --no-text       hide user and assistant messages
  --strict        exit 1 if any line failed to parse
  -h, --help      show this help
  --version       show the version number
`;

interface Options {
  command: 'stats' | 'show';
  file: string;
  json: boolean;
  tool: string | undefined;
  maxArgLength: number;
  includeText: boolean;
  strict: boolean;
}

type ParseResult = { kind: 'help' } | { kind: 'version' } | { kind: 'error'; message: string } | { kind: 'ok'; options: Options };

function parseArgs(argv: readonly string[]): ParseResult {
  if (argv.includes('-h') || argv.includes('--help')) return { kind: 'help' };
  if (argv.includes('--version')) return { kind: 'version' };

  const [command, ...rest] = argv;
  if (command !== 'stats' && command !== 'show') {
    return { kind: 'error', message: command ? `unknown command "${command}"` : 'missing command' };
  }

  let file: string | undefined;
  let json = false;
  let tool: string | undefined;
  let maxArgLength = 80;
  let includeText = true;
  let strict = false;

  for (const arg of rest) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--no-text') {
      includeText = false;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--tool=')) {
      tool = arg.slice('--tool='.length);
    } else if (arg.startsWith('--max-arg=')) {
      const raw = arg.slice('--max-arg='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return { kind: 'error', message: `--max-arg must be a positive integer, got "${raw}"` };
      }
      maxArgLength = n;
    } else if (arg.startsWith('-')) {
      return { kind: 'error', message: `unknown option "${arg}"` };
    } else if (file !== undefined) {
      return { kind: 'error', message: `unexpected argument "${arg}"` };
    } else {
      file = arg;
    }
  }

  if (file === undefined) return { kind: 'error', message: 'missing <file> argument' };

  return { kind: 'ok', options: { command, file, json, tool, maxArgLength, includeText, strict } };
}

function readInput(file: string): string {
  return readFileSync(file === '-' ? 0 : file, 'utf8');
}

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

export function run(argv: readonly string[]): number {
  const parsed = parseArgs(argv);

  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  const { options } = parsed;

  let text: string;
  try {
    text = readInput(options.file);
  } catch (err) {
    const source = options.file === '-' ? 'stdin' : options.file;
    process.stderr.write(`cannot read ${source}: ${(err as Error).message}\n`);
    return 2;
  }

  const { events, issues } = parseTrace(text);

  if (issues.length > 0) {
    if (options.strict) {
      for (const issue of issues) process.stderr.write(`${formatIssue(issue)}\n`);
      return 1;
    }
    process.stderr.write(`skipping ${issues.length} unusable line(s)\n`);
  }

  if (events.length === 0) {
    process.stderr.write('no usable events in trace\n');
    return 1;
  }

  if (options.command === 'stats') {
    const stats = computeStats(events);
    process.stdout.write(`${options.json ? JSON.stringify(stats, null, 2) : renderStats(stats)}\n`);
    return 0;
  }

  const timelineOptions: TimelineOptions = {
    tool: options.tool,
    maxArgLength: options.maxArgLength,
    includeText: options.includeText,
  };
  process.stdout.write(`${renderTimeline(events, timelineOptions)}\n`);
  return 0;
}

process.exit(run(process.argv.slice(2)));
