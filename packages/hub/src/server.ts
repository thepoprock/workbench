import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Me, Push, Request, Response } from '@workbench/shared';

export interface Client {
  push(p: Push): void;
  user: Me; // who connected: the owner (hub.json's token) or a user with their own key
}

// A handler may return a value, a promise, or { result, after } to run code
// once the response is on the wire (e.g. flushing output held during attach).
export type Reply = { result: unknown; after: () => void };
export type Dispatch = (req: Request, client: Client) => unknown;
export const reply = (result: unknown, after: () => void): Reply => ({ result, after });
const isReply = (v: unknown): v is Reply => typeof v === 'object' && v !== null && 'after' in v && 'result' in v;

// Plain HTTP on the same port, for callers that can't speak websocket
// (Claude Code hooks via curl). Returns the status code to send.
export type HttpRoute = (path: string, headers: IncomingMessage['headers'], body: string) => number;

const MAX_BODY = 8 * 1024 * 1024;

function handleHttp(req: IncomingMessage, res: ServerResponse, route: HttpRoute): void {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
    } else chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let status = 500;
    try {
      status = route(req.url ?? '/', req.headers, Buffer.concat(chunks).toString('utf8'));
    } catch {
      status = 400;
    }
    res.writeHead(status).end();
  });
}

export interface Server {
  port: number;
  broadcast(push: Push): void;
  close(): Promise<void>;
}

// Localhost only, and every connection must present a key: the token from hub.json
// (the owner) or a user's own key. The key is what stops a web page in any browser
// from talking to the hub. `visible` decides which pushes a user's connection gets.
export function startServer(
  dispatch: Dispatch,
  token: string,
  onDisconnect: (client: Client) => void,
  route: HttpRoute,
  auth: { owner: Me; byKey: (key: string) => Me | null; visible: (user: Me, push: Push) => boolean },
): Promise<Server> {
  const expected = Buffer.from(token);
  const clients = new Map<WebSocket, Client>();
  const who = (req: IncomingMessage): Me | null => {
    const key = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
    const given = Buffer.from(key);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return auth.owner;
    return key ? auth.byKey(key) : null;
  };

  const http = createServer((req, res) => handleHttp(req, res, route));
  const wss = new WebSocketServer({ server: http, verifyClient: ({ req }: { req: IncomingMessage }) => !!who(req) });

  wss.on('connection', (ws, req) => {
    const user = who(req);
    if (!user) return ws.terminate(); // the key was removed between the check and here
    const client: Client = {
      user,
      push: (p) => {
        if (ws.readyState === ws.OPEN && (user.owner || auth.visible(user, p))) ws.send(JSON.stringify(p));
      },
    };
    clients.set(ws, client);
    ws.on('close', () => {
      clients.delete(ws);
      onDisconnect(client);
    });
    ws.on('message', async (raw) => {
      let req: Request;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const send = (r: Response) => {
        if (req.id !== undefined && ws.readyState === ws.OPEN) ws.send(JSON.stringify(r));
      };
      try {
        const out = await dispatch(req, client);
        if (isReply(out)) {
          send({ id: req.id!, result: out.result });
          out.after();
        } else {
          send({ id: req.id!, result: out ?? null });
        }
      } catch (err) {
        send({ id: req.id!, error: { code: 'failed', message: (err as Error).message } });
      }
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      resolve({
        port: (http.address() as AddressInfo).port,
        broadcast(push) {
          const frame = JSON.stringify(push);
          for (const [ws, c] of clients) if (ws.readyState === ws.OPEN && (c.user.owner || auth.visible(c.user, push))) ws.send(frame);
        },
        close: () =>
          new Promise((r) => {
            // ws v8 waits for open connections before the callback fires.
            for (const ws of clients.keys()) ws.terminate();
            wss.close(() => http.close(() => r()));
          }),
      });
    });
  });
}
