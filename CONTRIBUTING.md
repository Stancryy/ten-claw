# Contributing to TenClaw

Thank you for your interest in contributing to TenClaw! This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/ten-claw.git`
3. Install dependencies: `npm install`
4. Start infrastructure: `npm run infra:up`
5. Run the demo: `npm run demo`

## Development Setup

### Prerequisites

- Node.js 18+
- Docker (for Redis and ChromaDB)
- TypeScript

### Environment Variables

Create a `.env` file:

```env
# Required for cloud providers
OPENAI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here

# Optional - for local development
LLM_PROVIDER=lmstudio
REDIS_URL=redis://localhost:6379
CHROMA_URL=http://localhost:8000
```

## Making Changes

1. Create a branch: `git checkout -b feature/my-feature`
2. Make your changes
3. Run type check: `npm run typecheck`
4. Commit: `git commit -m "feat: add new feature"`
5. Push: `git push origin feature/my-feature`
6. Open a Pull Request

## Commit Message Convention

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Test changes
- `chore:` Build/config changes

## Code Style

- Use TypeScript strict mode
- Follow existing code patterns
- Add types to all public APIs
- Include JSDoc for complex functions

## Testing

Before submitting:
- [ ] `npm run typecheck` passes
- [ ] Demo runs successfully (`npm run demo`)
- [ ] No secrets or API keys in code

## Questions?

Open an issue for:
- Bug reports
- Feature requests
- Documentation improvements

## Code of Conduct

Be respectful and constructive in all interactions.
