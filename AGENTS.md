# Faultlab engineering guide

## Stack
Vite, React, strict TypeScript, Tailwind CSS, and Vitest.

## Directories
- `src/engine/`: pure TypeScript simulation core and contracts.
- `src/scenarios/`: India-scale topologies and SEV-1 incident definitions.
- `src/ui/`: React components, Canvas renderer, and charts.
- `test/`: unit, mathematical invariant, and headless scenario tests.
- `docs/`: architecture documentation.

## Commands
- `npm run dev` starts the development server.
- `npm test` runs the Vitest suite.
- `npm run typecheck` checks TypeScript without emitting files.
- `npm run build` creates the production build.

## Engineering rules
- Keep `src/engine/` pure and zero-DOM: no React, DOM, `window`, or `Date.now()`.
- Use a seeded deterministic PRNG for simulation randomness.
- Write or update Vitest tests for every engine rule.
- Make small, focused changes.
- Never use mock or fake latency numbers; derive latency from the simulation.
