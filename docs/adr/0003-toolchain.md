# 0003: Toolchain pins and running TypeScript without a build

Status: Accepted, 2 October 2026. Does not change the spec.

TypeScript is pinned to 6.0.3 although 7.0.2 is current, because typescript-eslint 8.71 declares support only below 6.1 and type-aware linting is worth more than the newer compiler for now; revisit when typescript-eslint supports 7. Workspace packages export their `.ts` sources directly and Node 22 runs them through its built-in type stripping, so there is no build step between packages; `erasableSyntaxOnly` in `tsconfig.base.json` keeps the code to syntax Node can strip (no enums, namespaces or parameter properties). Browser code is bundled by esbuild. Tests run on Vitest 5 with Vite 8 as its peer, and lint is ESLint 10 with typescript-eslint's strict type-checked rules plus Prettier.

Playwright is pinned to 1.56.1 because the cloud sandbox ships its matching Chromium (build 1194, Chromium 141) and forbids browser downloads; on a laptop or in CI, `playwright install chromium` fetches the same build. `CHROMIUM_EXECUTABLE` points the harness at any other Chrome, which is how the baseline ran against native WebMCP in Chrome 154 and 156. MCP-B packages are pinned to 5.1.0, the current `latest`; their 6.0 beta follows the newer WebMCP draft and is the upgrade to test once it is stable.
