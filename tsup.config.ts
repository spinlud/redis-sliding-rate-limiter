import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        express: 'src/middleware/express-middleware.ts',
        fastify: 'src/middleware/fastify-plugin.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
    outDir: 'dist',
    // Share the RateLimiter/core chunk across entries in both CJS and ESM.
    splitting: true,
    // Peer libraries used only for their types in the framework adapters.
    // Keep them out of the bundle so consumers resolve their own copies.
    external: ['express', 'fastify', 'redis', 'ioredis'],
});
