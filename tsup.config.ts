import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
    outDir: 'dist',
    // Peer libraries used only for their types in the express middleware.
    // Keep them out of the bundle so consumers resolve their own copies.
    external: ['express', 'redis', 'ioredis'],
});
