// Bundles the hub into one file the packaged app runs with Electron's own Node
// (ELECTRON_RUN_AS_NODE). node-pty stays external: it ships native binaries.
import { build } from 'esbuild';

await build({
  entryPoints: ['packages/hub/src/index.ts'],
  outfile: 'packages/app/out/hub/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['node-pty'],
  // CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __wbRequire } from 'node:module'; const require = __wbRequire(import.meta.url);" },
  logLevel: 'info',
});
