import type { WorkbenchApi } from '../preload/index.ts';

declare global {
  interface Window {
    workbench: WorkbenchApi;
  }
}
