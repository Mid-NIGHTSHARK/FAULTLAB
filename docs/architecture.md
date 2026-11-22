# Architecture

The engine is a pure TypeScript simulation core. Scenario definitions describe topologies and incidents. The UI will consume engine output through React, a Canvas renderer, and charts. Tests cover engine rules, mathematical invariants, and headless scenarios without relying on the browser.
