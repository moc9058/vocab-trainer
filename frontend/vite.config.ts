import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const productionOrigin = 'https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const ios = mode === 'ios' || mode === 'ios-local';
  const origin = env.VITE_API_ORIGIN || productionOrigin;
  if (ios) {
    const url = new URL(origin);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('VITE_API_ORIGIN must be an origin only');
    if (mode === 'ios' && origin !== productionOrigin) throw new Error('Release iOS API must use the existing Cloud Run frontend origin');
    if (mode === 'ios-local' && !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid local API protocol');
  }
  return {
    plugins: [react(), tailwindcss(), ...(ios ? [{ name: 'ios-build-metadata',
      generateBundle(this: { emitFile: (file: object) => void }) { this.emitFile({ type: 'asset', fileName: 'ios-build.json', source: JSON.stringify({ mode, apiOrigin: origin }) }); }
    }] : [])],
    build: { outDir: ios ? 'dist-ios' : 'dist' },
    server: { proxy: { '/api': 'http://localhost:3000' } },
  };
});
