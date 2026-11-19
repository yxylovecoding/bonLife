import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './utils/appInstall';
import { appIdentity, isLifeApp } from './utils/apps';

const identity = appIdentity(window.location.hostname, window.location.pathname);
const isClothes = identity.kind === 'clothes', isLife = isLifeApp(identity.kind);
// Keep loaders separate so each app loads only its own styles and data.
const Root = isClothes ? React.lazy(() => import('./clothes/BonClothes')) : isLife
  ? React.lazy(() => import('./life/BonLife'))
  : React.lazy(() => import('./components/AuthGate'));
const appName = identity.name, appIcon = identity.icon;
const iconRevision = isClothes || identity.kind === 'bills' ? '?v=pastel-1' : '';
document.title = appName;
document.querySelector('meta[name="application-name"]')?.setAttribute('content', appName);
document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', appName);
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isClothes ? '#fff5f8' : isLife ? '#f6f5f3' : '#f0f2f5');
document.querySelector('link[rel="icon"]')?.setAttribute('href', `/${appIcon}.svg${iconRevision}`);
document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', `/icons/${appIcon}-180.png${iconRevision}`);
// Preserve legacy path identities while independent domains launch from their own roots.
const manifest = document.createElement('link');
manifest.rel = 'manifest';
manifest.href = identity.manifest;
document.head.appendChild(manifest);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense fallback={<main className="login-shell"><p role="status">加载中…</p></main>}><Root /></React.Suspense>
  </React.StrictMode>,
);
