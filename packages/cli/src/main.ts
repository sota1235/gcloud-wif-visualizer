#!/usr/bin/env -S npx tsx
import { collectCommand } from './collect-command.ts';
import { serveCommand } from './serve-command.ts';

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  collect: collectCommand,
  serve: serveCommand,
};

const USAGE = `使い方: wif-viz <command> [options]

コマンド:
  collect   GCP から WIF の設定と権限を収集し、スナップショットを作る
  serve     スナップショットをブラウザで表示する`;

const [command, ...args] = process.argv.slice(2);
const run = command ? COMMANDS[command] : undefined;
if (!run) {
  console.error(USAGE);
  process.exit(command ? 1 : 0);
}
try {
  process.exit(await run(args));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
