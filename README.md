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
│   └── architecture.md
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

## License

See LICENSE file for details.
