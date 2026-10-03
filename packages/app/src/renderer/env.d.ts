import type { WorkbenchApi } from '../preload/index.ts';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string };
    }
  }
  interface Window {
    workbench: WorkbenchApi;
  }
}
