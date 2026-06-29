// =============================================================================
// Entry point: apply Cate's theme, then mount the React app.
// =============================================================================

import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTheme } from './lib/theme'
import './styles.css'

void initTheme()

const el = document.getElementById('root')
if (el) createRoot(el).render(<App />)
