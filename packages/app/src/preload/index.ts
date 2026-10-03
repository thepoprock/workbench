import { contextBridge, ipcRenderer } from 'electron';
import type { HubDiscovery } from '@workbench/shared';

const api = {
  // Ensures a hub is running and returns where/how to reach it.
  connectHub: (): Promise<HubDiscovery> => ipcRenderer.invoke('hub:connect'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
};

export type WorkbenchApi = typeof api;
contextBridge.exposeInMainWorld('workbench', api);
