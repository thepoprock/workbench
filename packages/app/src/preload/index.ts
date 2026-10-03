import { contextBridge, ipcRenderer } from 'electron';
import type { HubDiscovery } from '@workbench/shared';

export type MenuItem = { id: string; label: string; enabled?: boolean } | { type: 'separator' };

const api = {
  // Ensures a hub is running and returns where/how to reach it.
  connectHub: (): Promise<HubDiscovery> => ipcRenderer.invoke('hub:connect'),
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
  menu: (items: MenuItem[]): Promise<string | null> => ipcRenderer.invoke('menu:popup', items),
  reveal: (path: string): Promise<string> => ipcRenderer.invoke('shell:reveal', path),
  notify: (title: string, body: string): Promise<void> => ipcRenderer.invoke('app:notify', title, body),
  setBadge: (count: number): Promise<void> => ipcRenderer.invoke('app:badge', count),
};

export type WorkbenchApi = typeof api;
contextBridge.exposeInMainWorld('workbench', api);
