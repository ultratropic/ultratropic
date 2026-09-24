import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ReviewerApp from './ReviewerApp';
import { uploadFiles } from './uploadPipeline';
import './styles.css';

// Exposed so a bulk upload can be driven from the console against an already
// authenticated session — also how the pipeline is exercised in testing.
(window as unknown as Record<string, unknown>).reviewUpload = uploadFiles;

// /p/<slug> is the project link (every album); /a/<token> is a client album link.
const match = window.location.pathname.match(/^\/(p|a)\/([A-Za-z0-9]+)/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {match ? <ReviewerApp base={`/api/${match[1]}/${match[2]}`} /> : <App />}
  </StrictMode>,
);
