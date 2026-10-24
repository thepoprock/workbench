import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Boundary } from './Boundary.tsx';
import { hub } from './hub.ts';
import './platform.ts';
import './styles.css';

hub.start();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary label="Workbench">
      <App />
    </Boundary>
  </StrictMode>,
);
