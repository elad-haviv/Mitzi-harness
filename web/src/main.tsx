import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './state';
import './styles.css';
import { manifestHref } from './api';

document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.setAttribute('href', manifestHref());
// The app shell for the home screen; service workers need https or localhost.
if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
