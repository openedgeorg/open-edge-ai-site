# Open Edge AI — ESP / Clear Ledger

Marketing website for ESP (Edge Settlement Protocol) and the Clear Ledger settlement story.

## Overview

This site presents ESP / Clear Ledger as a presentation-style marketing page with an AI-powered in-page explainer. The AI assistant is grounded in curated company source-of-truth (SoT) content—it serves as an educational companion, not a chat-as-product experience.

## Technology

- **Static site**: HTML, CSS, vanilla JavaScript
- **Minimal dependencies**: No heavy frameworks required
- **AI Explainer**: In-page assistant grounded in curated SoT (future: offline index support)

## Quick Start

```bash
cd site
python3 -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

## Project Structure

```
open-edge-ai-site/
├── README.md
├── CONTRIBUTING.md
├── .gitignore
├── docs/
│   ├── architecture.md
│   └── prd/
│       └── esp-ai-architecture-spec-v0.25.md
└── site/
    ├── index.html
    ├── css/
    │   └── main.css
    └── js/
        └── .gitkeep
```

## Roadmap

- [x] Initial scaffold
- [ ] ESP / Clear Ledger presentation content
- [ ] AI explainer component
- [ ] Curated SoT content pack
- [ ] Offline index support

## Workspace

The application is a Python 3.12 uv workspace. Packages live under `packages/`, `apps/api`, `services/`, and `providers/`. The marketing seed remains in `site/`. The development conversation client is `uv run python scripts/dev.py` and does not claim Gate 1.

Ordinary checks are `uv run ruff check .`, `uv run pyright`, and `uv run --all-packages pytest`. Live qualification commands stay outside that suite. v1 release readiness is blocked: no approved acceptance budget, reviewed corpus, or complete G0–G4 evidence bundle is recorded. See `docs/qualification/v1-readiness.md`.

## License

See LICENSE file for details.
