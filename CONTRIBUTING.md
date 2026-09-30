# Contributing to Open Edge AI Site

Thank you for your interest in contributing to the ESP / Open Edge AI marketing site.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code, stable releases |
| `dev/v1-ai-site` | Active v1 development branch for the AI-powered site |

### Workflow

1. **Feature development** happens on `dev/v1-ai-site` or feature branches off of it.
2. **Pull requests** should target `dev/v1-ai-site` for active development.
3. **Releases** are merged from `dev/v1-ai-site` → `main` after review.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/openedgeorg/open-edge-ai-site.git
cd open-edge-ai-site

# Switch to development branch
git checkout dev/v1-ai-site

# Start local server
cd site
python3 -m http.server 8080
```

## Guidelines

### Code Style

- Keep HTML semantic and accessible
- Use CSS custom properties for theming
- Vanilla JavaScript preferred; avoid heavy frameworks
- Minimal external dependencies

### Content

- All content should align with ESP / Clear Ledger messaging
- AI explainer content must be grounded in approved SoT
- No whitepaper PDFs or outdated CTAs

### Commits

- Use clear, descriptive commit messages
- Keep commits focused on single changes
- Reference issues where applicable

## Questions?

Open an issue for questions or discussions about contributing.
