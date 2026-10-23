import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer } from '@wif-viz/web/server';

const USAGE = `使い方: wif-viz serve <snapshot.jsonl.gz> [options]

  --port <n>   待ち受けるポート（デフォルト: 4000）`;

export async function serveCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string', default: '4000' }, help: { type: 'boolean', short: 'h' } },
  });
  const [snapshot] = positionals;
  if (values.help || !snapshot) {
    console.error(USAGE);
    return values.help ? 0 : 1;
  }
  const snapshotPath = resolve(snapshot);
  await access(snapshotPath);

  const server = await startServer({ snapshotPath, port: Number(values.port), log: (message) => console.error(`  ${message}`) });
  console.error(`http://127.0.0.1:${values.port}/ で表示しています（Ctrl+C で終了）`);
  await new Promise<void>((done) => {
    const stop = () => server.close().then(done);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
