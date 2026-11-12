# CIRCUIT — project guide

Financial control layer for autonomous agent networks on NEAR: one treasury, many agents,
one enforceable limit. Design: [docs/architecture.md](docs/architecture.md). Threats:
[docs/threat-model.md](docs/threat-model.md).

## Non-negotiables
- The contract (`contracts/circuit`) is the only authority. Off-chain code (API, simulator,
  dashboard) generates requests and observes results. It never makes authorisation decisions.
- Money is `u128` yoctoNEAR (`U128` strings in JSON, `bigint` in TS). Never use floats.
- All contract arithmetic is checked. Release builds keep `overflow-checks = true`.
- Carve-out accounting: delegation moves allocation out of the parent. A child's reservations
  are never charged to ancestors again.
- Invariants I1–I9 (architecture §4.2) must hold after every operation. Property tests enforce this.
- No secrets in git. Nothing is deployed and no funds are spent without explicit approval.
- Do not claim something works or report a benchmark number unless a real run backs it.

## Layout
- `contracts/circuit/`: Rust contract (near-sdk 5.30), with unit and property tests in `src/`
  and sandbox tests in `tests/`
- `packages/shared`, `packages/agent-simulator`: TS, pnpm workspace
- `apps/web`: read-only dashboard (Vite + TS). It reads contract views straight from the NEAR RPC.
  There is no off-chain API (cut 2026-11-12 for the deadline).
- `docs/`: architecture, threat model, contract spec, benchmarks

## Build environment
Build and test in **Linux (WSL Ubuntu or CI)**, not native Windows:
- near-sdk 5.30 refuses plain host builds (`cargo check`/`build`) unless the build is a unit-test
  build or uses `cargo near`.
- `near-sdk/unit-testing` pulls `aws-lc-sys`, which needs a C compiler, CMake and NASM.
- The NEAR sandbox (`neard`) has no Windows build.

## Commands
- Contract unit/property tests: `cargo test -p circuit`
- Wasm build: `cargo near build` (from `contracts/circuit`)
- Sandbox tests: `cargo test -p circuit --test '*'` (Linux only)

## Decisions
See architecture.md §13 (D1–D5).
