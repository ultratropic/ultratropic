<!--
If this file already exists, merge any unique project-specific notes
instead of overwriting. Keep this file short and actionable.
-->

# Copilot / AI Agent Instructions — my-website

Summary
- Minimal Astro site (template) configured to output a server runtime with Cloudflare adapter.

Quick setup
- Install dependencies: `npm install`.
- Run dev server: `npm run dev` (defaults to `localhost:4321`).
- Build for production: `npm run build`.

Architecture & important files
- `astro.config.mjs`: sets `output: 'server'` and imports `@astrojs/cloudflare`. This repo expects a server build and Cloudflare adapter — ensure the adapter package is installed before a server deployment.
- `package.json`: contains scripts: `dev`, `build`, `preview`, `astro` (run Astro CLI commands).
- `src/pages/`: Astro pages are routes. Example: `src/pages/about.astro` maps to `/about`.
- `public/`: static assets served at the site root (e.g. `public/img.png` -> `/img.png`).

Patterns, conventions & examples
- Routes: create `src/pages/your-page.astro` for a new route. For nested routes, use folders (e.g., `src/pages/blog/[slug].astro`).
- Components: none exist yet. If adding, use `src/components/` and import into `.astro` pages.
- Module type: repo uses `type: "module"` in `package.json` — add ESM imports/exports accordingly.

Deployment notes
- Because `astro.config.mjs` uses the Cloudflare adapter, builds target a server runtime: verify the target host supports Astro server builds (Cloudflare Pages/Workers with adapter support).
- If CI fails on build, check that `@astrojs/cloudflare` is installed and matches the installed `astro` version.

What AI agents should do first
- Preserve and reuse content in `README.md` when editing docs.
- When adding features, update `package.json` scripts only if necessary and document the change here.
- Prefer small, incremental edits (create a new page or component, run `npm run dev`, verify route).

Useful examples (copy/paste)
- Add a page: `src/pages/contact.astro` with basic HTML content — then `npm run dev` and visit `/contact`.
- Reference a static image: put it at `public/avatar.png` and use `<img src="/avatar.png" />`.

Limitations & notes
- No tests present — do not assume automated test coverage.
- This is a minimal starter; README suggests it may be replaced/removed by maintainers.

If anything in this file is unclear or you need deeper coverage (CI, deploy pipeline, or component conventions), ask for specifics and I will update this guidance.
