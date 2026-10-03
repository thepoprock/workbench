import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Push, Request, Response } from '@workbench/shared';

export interface Client {
  push(p: Push): void;
}

// A handler may return a value, a promise, or { result, after } to run code
// once the response is on the wire (e.g. flushing output held during attach).
export type Reply = { result: unknown; after: () => void };
export type Dispatch = (req: Request, client: Client) => unknown;
export const reply = (result: unknown, after: () => void): Reply => ({ result, after });
const isReply = (v: unknown): v is Reply => typeof v === 'object' && v !== null && 'after' in v && 'result' in v;

export interface Server {
  port: number;
  broadcast(push: Push): void;
  close(): Promise<void>;
}

// Localhost only, and every connection must present the token from hub.json.
// The token is what stops a web page in any browser from talking to the hub.
export function startServer(
  dispatch: Dispatch,
  token: string,
  onDisconnect: (client: Client) => void,
): Promise<Server> {
  const expected = Buffer.from(token);
  const clients = new Map<WebSocket, Client>();

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const given = Buffer.from(new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  });

  wss.on('connection', (ws) => {
    const client: Client = {
      push: (p) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(p));
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
    wss.once('error', reject);
    wss.once('listening', () => {
      resolve({
        port: (wss.address() as AddressInfo).port,
        broadcast(push) {
          const frame = JSON.stringify(push);
          for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(frame);
        },
        close: () =>
          new Promise((r) => {
            // ws v8 waits for open connections before the callback fires.
            for (const ws of clients.keys()) ws.terminate();
            wss.close(() => r());
          }),
      });
    });
  });
}
