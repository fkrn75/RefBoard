// 빌드 후처리: dist/sw.js의 CACHE_VERSION을 빌드 타임스탬프로 치환한다.
//
// 왜 필요한가: sw.js는 public 정적 파일이라 Vite가 dist로 "그대로" 복사한다(define/번들 해시가
// 안 먹음). CACHE_VERSION이 배포마다 안 바뀌면 sw.js의 activate가 옛 캐시를 절대 삭제하지 못해
// 옛 번들이 영구 잔류하고, 사용자가 매번 Ctrl+Shift+R 해야 한다. 빌드마다 버전을 갱신하면
// activate가 옛 캐시를 전부 비워 새 자산이 자연히 반영된다.
//
// package.json: "build": "tsc && vite build && node scripts/stamp-sw.mjs"

import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/sw.js')
// 예: 20260621T091530 형태의 14자리 타임스탬프(사람이 읽고 정렬 가능).
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

let src = await readFile(dist, 'utf8')
const before = src
src = src.replace(/const CACHE_VERSION = '[^']*'/, `const CACHE_VERSION = '${stamp}'`)

if (src === before) {
  // 치환이 안 됐다면 sw.js 구조가 바뀐 것 — 조용히 넘어가면 stale 버그가 되살아나므로 명확히 실패시킨다.
  console.error('[stamp-sw] CACHE_VERSION 패턴을 찾지 못함 — dist/sw.js 구조 확인 필요')
  process.exit(1)
}

await writeFile(dist, src) // BOM 없이 UTF-8
console.log('[stamp-sw] CACHE_VERSION =', stamp)
