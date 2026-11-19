import { defineConfig } from 'vite';

// Relative base so the production build can be served from any sub-path
// (GitHub Pages project sites, itch.io, an S3 bucket, a plain folder...).
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined)
      }
    }
  }
});
