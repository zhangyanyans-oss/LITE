// Reliable boot.js bundler using esbuild's JS API (avoids Windows cmd
// path-parsing issues with the @esbuild/win32-x64/esbuild.exe path).
import { build } from "esbuild";

const banner = `import { createRequire } from 'module';const require = createRequire(import.meta.url);`;

await build({
  entryPoints: ["api/boot.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  banner: { js: banner },
  logLevel: "info",
});

console.log("✓ dist/boot.js built");
