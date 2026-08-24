# Agent notes

## Verification
- Canonical check: `npm run build && npm run test:unit` (this is what CI runs).
- `npm test` runs unit + integration. Integration and e2e tests require
  Docker and Playwright browsers — NOT available in your sandbox.
  Do not run them; do not treat their absence as a gap to fix.
- A change is done when build + unit tests pass and new behavior has
  unit coverage under `test/unit/`.

## Environment
- Node 22. Install with `npm ci`.

## Conventions
- TypeScript strict; no new runtime dependencies without a stated reason.
