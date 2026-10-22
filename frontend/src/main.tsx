import './lib/sentry.ts'
import { reactErrorHandler } from '@sentry/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { FeatureFlagsProvider } from './components/FeatureFlagsProvider'

createRoot(document.getElementById('root')!, {
  onUncaughtError: reactErrorHandler(),
  onCaughtError: reactErrorHandler(),
  onRecoverableError: reactErrorHandler(),
}).render(
  <StrictMode>
    <BrowserRouter>
      <FeatureFlagsProvider><App /></FeatureFlagsProvider>
    </BrowserRouter>
  </StrictMode>,
)
