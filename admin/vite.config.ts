import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 5174: 8081 belongs to the Expo dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    // The rule editor imports the app's artist-key normalizer (one source of truth
    // for "name:<artistKey>" keys), so allow exactly that folder.
    fs: { allow: ['.', '../app/src/link'] },
  },
});
