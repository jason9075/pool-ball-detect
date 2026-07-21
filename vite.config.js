import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/pool-ball-detect/' : '/',
  build: {
    outDir: 'dist',
  },
});
