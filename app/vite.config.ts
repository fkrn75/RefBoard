import { defineConfig } from 'vite'

// RefBoard 웹앱 Vite 설정.
// 나중에 Tauri가 이 프론트엔드를 그대로 로드한다(고정 포트 1420은 Tauri 관례).
export default defineConfig({
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' },
})
