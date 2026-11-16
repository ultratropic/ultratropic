import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ReviewerApp from './ReviewerApp';
import Gallery from './Gallery';
import SignIn from './SignIn';
import { loadBrand } from './brand';
import { uploadFiles } from './uploadPipeline';
import './styles.css';

// Exposed so a bulk upload can be driven from the console against an already
// authenticated session — also how the pipeline is exercised in testing.
(window as unknown as Record<string, unknown>).reviewUpload = uploadFiles;

// /p/<slug> is the project link (every album); /a/<token> is a client album link.
// /c/<token> is a curated client link: chosen people in sections, no sidebar.
const match = window.location.pathname.match(/^\/(p|a|c)\/([A-Za-z0-9-]+)/);
// /v/<token> is a view-only page of selects, for clients.
const view = window.location.pathname.match(/^\/v\/([A-Za-z0-9]+)/);

void loadBrand().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {view ? <Gallery base={`/api/v/${view[1]!}`} admin={false} viewOnly />
        : match ? <ReviewerApp base={`/api/${match[1]}/${match[2]}`} />
        : location.pathname === '/signin' ? <SignIn /> : <App />}
    </StrictMode>,
  ));
