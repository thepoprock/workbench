import type { Method, Methods, Push, Response } from '@workbench/shared';

export type HubStatus = 'connecting' | 'connected' | 'disconnected';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

// One websocket to the hub. Reconnects (and restarts the hub via main) on drop.
class HubClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private statusListeners = new Set<(s: HubStatus) => void>();
  private pushListeners = new Set<(p: Push) => void>();
  status: HubStatus = 'disconnected';
  lastError: string | null = null;

  start(): void {
    void this.connect();
  }

  private setStatus(s: HubStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private async connect(): Promise<void> {
    this.setStatus('connecting');
    try {
      const d = await window.workbench.connectHub();
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}/?token=${d.token}`);
      ws.onopen = () => {
        this.ws = ws;
        this.lastError = null;
        this.setStatus('connected');
      };
      ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string));
      ws.onclose = () => this.onClose();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.onClose();
    }
  }

  private onClose(): void {
    this.ws = null;
    for (const p of this.pending.values()) p.reject(new Error('hub disconnected'));
    this.pending.clear();
    this.setStatus('disconnected');
    setTimeout(() => void this.connect(), 2000);
  }

  private onMessage(msg: Response | Push): void {
    if ('event' in msg) {
      for (const l of this.pushListeners) l(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if ('error' in msg) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  call<M extends Method>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('hub not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Fire-and-forget (no id → hub sends no response). Dropped while disconnected.
  notify<M extends Method>(method: M, params: Methods[M]['params']): void {
    this.ws?.send(JSON.stringify({ method, params }));
  }

  onStatus(l: (s: HubStatus) => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  onPush(l: (p: Push) => void): () => void {
    this.pushListeners.add(l);
    return () => this.pushListeners.delete(l);
  }
}

export const hub = new HubClient();
