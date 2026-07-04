import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import QuickAsk from './QuickAsk.jsx'

// #quick loads the compact overlay.
const isQuickAsk = window.location.hash === '#quick'

createRoot(document.getElementById('root')).render(isQuickAsk ? <QuickAsk /> : <App />)
