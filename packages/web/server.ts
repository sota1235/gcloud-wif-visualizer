import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshotFile } from '@wif-viz/core/node';
import react from '@vitejs/plugin-react';
import { createServer, type Plugin } from 'vite';
import { createSnapshotApi } from './snapshot-api.ts';

export interface ServeOptions {
  snapshotPath: string;
  port: number;
  /** 機密情報を含むため、デフォルトでは localhost のみで待ち受ける */
  host?: string;
  /** 進捗の出力先 */
  log?: (message: string) => void;
}

function snapshotPlugin(handle: ReturnType<typeof createSnapshotApi>): Plugin {
  return {
    name: 'wif-viz-snapshot',
    configureServer(server) {
      server.middlewares.use('/api/', (req, res) => {
        const url = new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost');
        const { status, body } = handle(url.pathname, url.searchParams);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
  };
}

export async function startServer(options: ServeOptions) {
  options.log?.('スナップショットを読み込んでいます');
  const file = await readSnapshotFile(options.snapshotPath);
  options.log?.(`インベントリ ${file.inventory.size} 件を読み込みました`);
  const server = await createServer({
    root: dirname(fileURLToPath(import.meta.url)),
    configFile: false,
    logLevel: 'warn',
    plugins: [react(), snapshotPlugin(createSnapshotApi(file))],
    server: { host: options.host ?? '127.0.0.1', port: options.port, strictPort: true },
  });
  await server.listen();
  return server;
}
