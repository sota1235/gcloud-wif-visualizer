import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer, type Plugin } from 'vite';

export interface ServeOptions {
  snapshotPath: string;
  port: number;
  /** 機密情報を含むため、デフォルトでは localhost のみで待ち受ける */
  host?: string;
}

/** /api/snapshot でスナップショットを返す */
function snapshotPlugin(snapshotPath: string): Plugin {
  return {
    name: 'wif-viz-snapshot',
    configureServer(server) {
      server.middlewares.use('/api/snapshot', async (_req, res) => {
        try {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(await readFile(snapshotPath, 'utf8'));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}

export async function startServer(options: ServeOptions) {
  const server = await createServer({
    root: dirname(fileURLToPath(import.meta.url)),
    configFile: false,
    logLevel: 'warn',
    plugins: [react(), snapshotPlugin(options.snapshotPath)],
    server: { host: options.host ?? '127.0.0.1', port: options.port, strictPort: true },
  });
  await server.listen();
  return server;
}
