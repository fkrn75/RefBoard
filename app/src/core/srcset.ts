// 다중 해상도 이미지 세트 생성 — 웹 공유 시 대역폭·초기 로딩을 줄인다(Phase 5.1/5.3).
//
// 한 장의 원본 src에서 thumb(작게)/medium(보드뷰)/orig(라이트박스) 3종을 만든다.
// downscale.ts의 downscaleIfLarge를 해상도별로 호출해 재사용하며, 가능하면 WebP로
// 인코딩해 용량을 더 줄인다(WebP 미지원 환경은 자동으로 PNG/JPEG 폴백).
//
// 적용 시점: "공유 export"에서만(클라우드 업로드 등). 편집 보드(.refb)는 단일 src를
// 유지해 파일이 3배로 커지는 것을 피한다. 뷰어는 srcs가 있으면 medium/orig를 고르고
// 없으면 src로 폴백하므로(scene/lightbox), 이 함수를 거치지 않은 보드도 그대로 열린다.
//
// 좌표계 정합 주의: medium(축소 텍스처)을 그대로 쓰면 원본(natural) 기준 transform과
// 크기가 어긋난다. scene.applyTransform이 보정배율 k=natural.w/texture.width를 실어
// 같은 월드 크기로 표시한다. 다만 crop은 frame이 원본 픽셀 기준이라 축소 텍스처와
// 정합이 복잡하므로, crop이 있는 이미지와 GIF(정지 축소 시 애니 손실)는 srcset 생성에서
// 제외한다(→ src 폴백으로 안전).

import { downscaleIfLarge } from './downscale'
import type { BoardState, BoardImage, ImageSrcSet } from './board'

export interface SrcSetOptions {
  thumbEdge?: number  // thumb 긴 변(px). 기본 256
  mediumEdge?: number // medium 긴 변(px). 기본 1024
  origEdge?: number   // orig 상한 긴 변(px). 초과만 축소(이하 원본 보존). 기본 4096
}

// WebP 인코딩 가능 여부(브라우저 1회 감지 후 캐시). 미지원이면 downscale가 PNG/JPEG로 폴백.
let webpEncodeOk: boolean | null = null
function canEncodeWebp(): boolean {
  if (webpEncodeOk !== null) return webpEncodeOk
  try {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    webpEncodeOk = c.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    webpEncodeOk = false
  }
  return webpEncodeOk
}

// GIF는 정지 축소 시 애니메이션을 잃으므로 srcset 생성에서 제외한다(뷰어가 src로 폴백).
function isGifSrc(src: string): boolean {
  return /^data:image\/gif/i.test(src) || /\.gif(\?|#|$)/i.test(src)
}

/**
 * 한 장의 src에서 다중 해상도 세트를 만든다.
 * - thumb: thumbEdge 긴 변, WebP 저품질(대역폭 우선)
 * - medium: mediumEdge 긴 변, WebP 중품질(보드 뷰 기본)
 * - orig: origEdge 상한(초과만 축소). 이하 원본은 그대로 보존(라이트박스 화질).
 * 한 해상도가 실패해도 throw하지 않고 그 자리에 원본 src를 넣는다(graceful).
 */
export async function buildSrcSet(src: string, opts: SrcSetOptions = {}): Promise<ImageSrcSet> {
  const thumbEdge = opts.thumbEdge ?? 256
  const mediumEdge = opts.mediumEdge ?? 1024
  const origEdge = opts.origEdge ?? 4096
  const format: 'auto' | 'webp' = canEncodeWebp() ? 'webp' : 'auto'

  // 각 해상도 독립 생성 — 한 해상도가 실패해도 나머지는 살린다.
  // (단순성 우선: 해상도별로 원본을 다시 디코드한다. 1회 디코드 재사용 최적화는 후속.)
  const make = async (maxEdge: number, quality: number): Promise<string> => {
    try {
      const r = await downscaleIfLarge(src, { maxEdge, quality, format })
      return r.dataUrl
    } catch {
      return src // 실패 시 원본 폴백
    }
  }

  const [thumb, medium, orig] = await Promise.all([
    make(thumbEdge, 0.7),
    make(mediumEdge, 0.82),
    make(origEdge, 0.9),
  ])
  return { thumb, medium, orig }
}

/**
 * 보드의 모든 이미지 아이템에 srcs(다중 해상도)를 채운 새 BoardState를 만든다.
 * 원본 board는 변경하지 않는다(깊은 복제). srcs를 채운 아이템은 원본 src를 ''로 비워
 * 공유 저장/전송 용량이 2배가 되는 것을 막는다(P1#4). 공유 export 직전에 호출한다.
 * crop/GIF 이미지는 좌표·애니 정합 문제로 건너뛴다(→ src 유지, 뷰어가 src로 폴백).
 * @param opts.onProgress (done, total) 진행 콜백(이미지가 많을 때 UI 표시용, 선택)
 */
export async function attachSrcSets(
  board: BoardState,
  opts: SrcSetOptions & { onProgress?: (done: number, total: number) => void } = {},
): Promise<BoardState> {
  // 구조적 복제(원본 불변). structuredClone 미지원 환경은 JSON 왕복으로 폴백.
  const clone: BoardState =
    typeof structuredClone === 'function'
      ? structuredClone(board)
      : (JSON.parse(JSON.stringify(board)) as BoardState)

  // 다중해상도 대상: 이미지 + crop 없음 + GIF 아님(나머지는 src 폴백으로 안전).
  const targets = clone.items.filter(
    (it): it is BoardImage => it.type === 'image' && !it.crop && !isGifSrc(it.src),
  )
  const total = targets.length
  let done = 0
  opts.onProgress?.(0, total)

  // 장끼리는 순차 — 대량 보드에서 동시에 수십 장×3해상도를 인코딩하면 메모리가 폭증한다.
  // (한 장당 buildSrcSet 내부에서 3해상도는 병렬, 장끼리는 순차로 균형.)
  for (const img of targets) {
    img.srcs = await buildSrcSet(img.src, opts)
    // 원본 data URL 제거 — srcs(thumb/medium/orig)로 대체되어 불필요(P1#4: 잔류 시 공유 저장/전송 용량 2배).
    // srcs가 채워진 이 아이템만 비운다. crop/GIF·구보드는 targets에서 제외돼 src를 유지하므로
    // 뷰어 폴백(scene: srcs?.medium ?? src, lightbox: srcs?.orig ?? src)이 깨지지 않는다.
    img.src = ''
    done++
    opts.onProgress?.(done, total)
  }
  return clone
}
