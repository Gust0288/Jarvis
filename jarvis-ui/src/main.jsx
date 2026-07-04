import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import QuickAsk from './QuickAsk.jsx'

// The Electron quick-ask overlay loads the same bundle with #quick —
// render the compact panel instead of the full HUD
const isQuickAsk = window.location.hash === '#quick'

createRoot(document.getElementById('root')).render(isQuickAsk ? <QuickAsk /> : <App />)
