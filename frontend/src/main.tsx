import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import App from './App'
import { DemoSessionProvider } from './context/DemoSession'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <DemoSessionProvider>
        <App />
      </DemoSessionProvider>
    </MotionConfig>
  </StrictMode>,
)
