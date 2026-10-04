# Architecture

## Overview

The Open Edge AI site is a static marketing website presenting ESP (Edge Settlement Protocol) and the Clear Ledger settlement story. It features an AI-powered in-page explainer grounded in curated source-of-truth content.

## Design Principles

1. **Static-first**: Pure HTML/CSS/JS with no server-side rendering required
2. **Minimal dependencies**: Avoid heavy frameworks; vanilla JavaScript where possible
3. **Progressive enhancement**: Core content accessible without JavaScript
4. **Grounded AI**: AI explainer uses curated SoT, not general chat

## Site Structure

```
site/
├── index.html      # Main presentation page
├── css/
│   └── main.css    # Core styles
└── js/
    └── (modules)   # JavaScript modules (future)
```

## Components

### Presentation Layer

- **Hero section**: ESP / Clear Ledger value proposition
- **Feature sections**: Key capabilities and benefits
- **Settlement story**: Clear Ledger narrative flow

### AI Explainer (Planned)

- In-page assistant UI component
- Grounded in curated company SoT content
- Not a general-purpose chatbot—educational focus
- Future: offline index for faster responses

## Implemented services

The running tree is a uv workspace. `apps/api` is the browser boundary. `packages/runtime_harconses` supervises native sessions. `packages/recovery` reconciles a failed incarnation only after a positive storage fence. `services/esp_mcp` and `packages/esp_knowledge_client` serve published source versions. `site/js` is the vanilla client. Qualification commands in `scripts/qualify.py` fail closed when evidence is missing.

Native history stays on the runtime volume. The knowledge deployment does not mount it. Deletion is unsupported until a peer-safe mechanism is selected. See `docs/runbooks/operations.md`.

## Content Strategy

All site content aligns with approved ESP / Clear Ledger messaging:

- Settlement protocol capabilities
- Edge computing benefits
- Clear Ledger transparency story

## Future Enhancements

- Curated SoT content pack integration
- Offline index for AI explainer
- Analytics and engagement tracking
