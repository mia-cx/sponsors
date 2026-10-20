import {defineConfig} from 'vite';

// The dashboard is a static page under /admin, served by the Worker after it checks Cloudflare Access.
export default defineConfig({
  root: 'src/admin',
  base: '/admin/',
  build: {outDir: '../../dist/admin', emptyOutDir: true},
});
