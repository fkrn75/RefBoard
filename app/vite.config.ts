import { defineConfig } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// RefBoard Vite 설정 (멀티페이지).
//  - main:   데스크탑/웹 편집 앱(index.html) — 나중에 Tauri가 그대로 로드(고정 포트 1420).
//  - viewer: 읽기전용 웹 뷰어(viewer.html, Phase 5 공유) — core를 재사용한다.
const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  server: { port: 1420, strictPort: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        viewer: resolve(root, 'viewer.html'),
      },
    },
  },
})
