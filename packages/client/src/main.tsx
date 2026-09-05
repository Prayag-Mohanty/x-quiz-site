/**
 * Entry point and the whole of the routing.
 *
 * Three surfaces, one bundle, no router library — DECISIONS.md is explicit that
 * this app has no routing complexity worth a framework. The path picks a
 * component and that is the extent of it.
 *
 *   /        the authoring tool (Phase 0)
 *   /play    the team client
 *   /qm         the quizmaster console
 *   /scoreboard  the public, read-only scoreboard
 *   /breakdown   the post-quiz report, behind the quizmaster's token
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { TeamApp } from './live/TeamApp.js';
import { QmApp } from './live/QmApp.js';
import { ScoreboardApp } from './live/ScoreboardApp.js';
import { BreakdownApp } from './live/BreakdownApp.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

function Router() {
  const path = window.location.pathname;
  if (path.startsWith('/play')) return <TeamApp />;
  if (path.startsWith('/qm')) return <QmApp />;
  if (path.startsWith('/scoreboard')) return <ScoreboardApp />;
  if (path.startsWith('/breakdown')) return <BreakdownApp />;
  return <App />;
}

createRoot(root).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
