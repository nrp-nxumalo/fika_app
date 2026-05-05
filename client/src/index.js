import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

const clearLegacyAppShellCache = async () => {
  if (!('caches' in window)) {
    return;
  }

  const cacheNames = await window.caches.keys();

  await Promise.all(
    cacheNames
      .filter((cacheName) => cacheName.startsWith('fika-app-shell-'))
      .map((cacheName) => window.caches.delete(cacheName))
  );
};

const unregisterLegacyServiceWorkers = async () => {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();

  await Promise.all(registrations.map((registration) => registration.unregister()));
};

if (process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    Promise.all([
      unregisterLegacyServiceWorkers(),
      clearLegacyAppShellCache(),
    ]).catch((error) => {
      console.error('Legacy app shell cleanup failed:', error);
    });
  });
}
