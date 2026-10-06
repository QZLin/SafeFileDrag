/**
 * The static file server shared by the manual playground and the Gecko test.
 *
 * A local `http://` origin is used on purpose: content scripts never run on `data:`
 * URLs, and `file://` needs an extra per-add-on permission that would only add a
 * failure mode.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * @param {object} options
 * @param {string} options.root      directory to serve
 * @param {number} options.port      first port to try; up to 10 consecutive ones
 * @param {string} [options.host]
 * @param {(context: { request: import('node:http').IncomingMessage, url: URL, send: (status: number, type: string, body: string) => void }) => boolean | Promise<boolean>} [options.onRequest]
 *        handled first; return `true` when the request is answered
 */
export async function startStaticServer({ root, port, host = '127.0.0.1', onRequest }) {
  const rootPath = resolve(root);

  const server = createServer(async (request, response) => {
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };

    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (onRequest && (await onRequest({ request, url, send }))) return;

      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      const filePath = resolve(join(rootPath, normalize(pathname)));
      if (filePath !== rootPath && !filePath.startsWith(rootPath + sep)) {
        send(403, 'text/plain; charset=utf-8', 'forbidden');
        return;
      }

      const body = await readFile(filePath);
      send(200, MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream', body);
    } catch {
      send(404, 'text/plain; charset=utf-8', 'not found');
    }
  });

  const boundPort = await listen(server, port, host);
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}/`,
    server,
    close: () => server.close(),
  };
}

async function listen(server, port, host) {
  for (let candidate = port; candidate < port + 10; candidate++) {
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, host);
      });
      return candidate;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`no free port in ${port}..${port + 9}`);
}
