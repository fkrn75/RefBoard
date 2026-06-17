// 대형 이미지 자동 다운스케일 모듈 (Phase 4.6)
//
// 목적: 거대한 원본 이미지를 보드에 그대로 임베드하면 메모리·.refb 파일 크기·
// 렌더 성능이 모두 악화된다. 긴 변이 임계값(maxEdge)을 넘는 이미지를 비율 유지로
// 축소해 표시·저장용 src를 가볍게 만든다. 임계값 이하면 원본을 그대로 돌려준다.
//
// 설계 원칙:
// - 데스크탑(Tauri WebView)·웹 공유 양쪽에서 동작하도록 OffscreenCanvas 우선,
//   미지원 환경은 document.createElement('canvas')로 폴백.
// - 실패 시 throw하지 않고 원본을 graceful 반환(downscaled:false) — 가져오기 흐름이
//   한 장 때문에 중단되지 않게 한다.
// - 알파 보존: 알파 가능 입력(PNG/WebP/GIF/dataURL 등)이면 image/png 유지,
//   불투명이 확실한 입력(JPEG)만 image/jpeg(quality). 보수적으로 PNG 기본.

export interface DownscaleOptions {
  /** 긴 변 최대 픽셀. 이 값을 넘으면 비율 유지로 축소. 기본 4096 */
  maxEdge?: number
  /** JPEG 출력 품질(0~1). PNG 출력에는 영향 없음. 기본 0.92 */
  quality?: number
  /** 2:1씩 단계 축소로 에일리어싱 완화. 기본 true */
  stepwise?: boolean
}

export interface DownscaleResult {
  /** 결과 이미지 dataURL (축소 안 했으면 원본 dataURL) */
  dataUrl: string
  /** 결과 폭(px) */
  width: number
  /** 결과 높이(px) */
  height: number
  /** 원본 픽셀 크기 */
  original: { w: number; h: number }
  /** 실제로 축소했는지 여부 */
  downscaled: boolean
  /** 축소 비율(결과/원본). 축소 안 했으면 1 */
  ratio: number
}

type ImageSource = string | Blob | File

// 알파 채널을 가질 수 있는 입력인지 판정.
// JPEG만 확실히 불투명이므로 그 외에는 보수적으로 알파 가능(=PNG 유지)으로 본다.
function mayHaveAlpha(src: ImageSource): boolean {
  // Blob/File: MIME 타입으로 판정
  if (typeof src !== 'string') {
    const t = src.type.toLowerCase()
    if (t === 'image/jpeg' || t === 'image/jpg') return false
    return true
  }
  // dataURL: 헤더의 MIME으로 판정 (data:image/jpeg;base64,...)
  const m = /^data:([^;,]+)[;,]/i.exec(src)
  if (m) {
    const t = m[1].toLowerCase()
    if (t === 'image/jpeg' || t === 'image/jpg') return false
    return true
  }
  // 그 외(http/파일 경로 등)는 확장자로 추정, 모르면 보수적으로 알파 가능
  if (/\.jpe?g(\?|#|$)/i.test(src)) return false
  return true
}

// 다양한 입력을 디코드해 ImageBitmap을 얻는다. createImageBitmap 우선,
// 미지원/실패 시 <img> 디코드로 폴백. 호출 측이 close()/정리 책임을 진다.
async function decodeToBitmap(
  src: ImageSource,
): Promise<{ bitmap: ImageBitmap | HTMLImageElement; w: number; h: number; isBitmap: boolean }> {
  // 1순위: createImageBitmap (string이면 fetch→blob 변환 필요)
  if (typeof createImageBitmap === 'function') {
    try {
      let blob: Blob
      if (typeof src === 'string') {
        const res = await fetch(src)
        blob = await res.blob()
      } else {
        blob = src
      }
      const bitmap = await createImageBitmap(blob)
      return { bitmap, w: bitmap.width, h: bitmap.height, isBitmap: true }
    } catch {
      // 폴백으로 진행 (예: fetch 불가한 dataURL 환경, 디코드 실패 등)
    }
  }

  // 2순위: HTMLImageElement 디코드
  const url = typeof src === 'string' ? src : URL.createObjectURL(src)
  try {
    const img = await loadImage(url)
    return { bitmap: img, w: img.naturalWidth, h: img.naturalHeight, isBitmap: false }
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(url)
  }
}

// <img> 로드 Promise 래퍼
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('이미지 디코드 실패'))
    img.src = url
  })
}

// 2D 컨텍스트를 가진 캔버스를 생성. OffscreenCanvas 우선, 미지원 시 <canvas> 폴백.
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (ctx) return { canvas, ctx: ctx as OffscreenCanvasRenderingContext2D }
    // 컨텍스트 획득 실패 시 <canvas>로 폴백
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  return { canvas, ctx }
}

// 캔버스를 dataURL로 변환 (OffscreenCanvas는 convertToBlob → FileReader 경유)
async function canvasToDataURL(canvas: AnyCanvas, mime: string, quality: number): Promise<string> {
  if (canvas instanceof HTMLCanvasElement) {
    return canvas.toDataURL(mime, quality)
  }
  // OffscreenCanvas: toDataURL이 없으므로 convertToBlob 사용
  const blob = await canvas.convertToBlob({ type: mime, quality })
  return blobToDataURL(blob)
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// 입력 src를 그대로 dataURL로 변환(축소 불필요 시 원본 반환용).
// 이미 dataURL이면 그대로, Blob/File이면 FileReader, http/경로면 fetch→blob.
async function sourceToDataURL(src: ImageSource): Promise<string> {
  if (typeof src === 'string') {
    if (src.startsWith('data:')) return src
    const res = await fetch(src)
    const blob = await res.blob()
    return blobToDataURL(blob)
  }
  return blobToDataURL(src)
}

/**
 * 긴 변이 maxEdge를 초과하면 비율 유지로 다운스케일한다.
 * 이하면 원본을 그대로 반환(downscaled:false).
 *
 * 실패 시 throw하지 않고 원본을 graceful 반환하며 콘솔 경고를 남긴다.
 */
export async function downscaleIfLarge(src: ImageSource, opts: DownscaleOptions = {}): Promise<DownscaleResult> {
  const maxEdge = opts.maxEdge ?? 4096
  const quality = opts.quality ?? 0.92
  const stepwise = opts.stepwise ?? true

  let decoded: { bitmap: ImageBitmap | HTMLImageElement; w: number; h: number; isBitmap: boolean } | null = null
  try {
    decoded = await decodeToBitmap(src)
    const { bitmap, w: srcW, h: srcH, isBitmap } = decoded
    const original = { w: srcW, h: srcH }
    const longest = Math.max(srcW, srcH)

    // 임계값 이하 → 축소 불필요. 원본 dataURL 그대로 반환.
    if (longest <= maxEdge || srcW === 0 || srcH === 0) {
      if (isBitmap) (bitmap as ImageBitmap).close()
      decoded = null
      const dataUrl = await sourceToDataURL(src)
      return { dataUrl, width: srcW, height: srcH, original, downscaled: false, ratio: 1 }
    }

    // 목표 크기 계산 (비율 유지, 정수 픽셀)
    const ratio = maxEdge / longest
    const targetW = Math.max(1, Math.round(srcW * ratio))
    const targetH = Math.max(1, Math.round(srcH * ratio))

    // 출력 MIME 결정 (알파 보존)
    const mime = mayHaveAlpha(src) ? 'image/png' : 'image/jpeg'

    let finalCanvas: AnyCanvas
    if (stepwise) {
      // 2:1씩 단계 축소: 한 번에 큰 비율로 줄이면 브라우저 보간이 에일리어싱을 남기므로
      // 절반씩 반복해 부드럽게 줄인다. 마지막 단계에서 정확한 목표 크기로 맞춘다.
      finalCanvas = stepwiseDownscale(bitmap, srcW, srcH, targetW, targetH)
    } else {
      // 단일 단계 축소
      const { canvas, ctx } = makeCanvas(targetW, targetH)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, targetW, targetH)
      finalCanvas = canvas
    }

    // ImageBitmap 리소스 해제
    if (isBitmap) (bitmap as ImageBitmap).close()
    decoded = null

    const dataUrl = await canvasToDataURL(finalCanvas, mime, quality)
    return {
      dataUrl,
      width: targetW,
      height: targetH,
      original,
      downscaled: true,
      ratio: targetW / srcW,
    }
  } catch (err) {
    // graceful 폴백: 원본을 최대한 그대로 반환
    console.warn('[downscale] 다운스케일 실패, 원본 사용:', err)
    // 남은 ImageBitmap 정리
    if (decoded?.isBitmap) {
      try {
        ;(decoded.bitmap as ImageBitmap).close()
      } catch {
        /* 무시 */
      }
    }
    try {
      const dataUrl = await sourceToDataURL(src)
      const w = decoded?.w ?? 0
      const h = decoded?.h ?? 0
      return { dataUrl, width: w, height: h, original: { w, h }, downscaled: false, ratio: 1 }
    } catch (err2) {
      // dataURL 변환마저 실패 — src가 이미 문자열이면 그거라도 반환, 아니면 재throw
      console.warn('[downscale] 원본 dataURL 변환도 실패:', err2)
      if (typeof src === 'string') {
        return { dataUrl: src, width: 0, height: 0, original: { w: 0, h: 0 }, downscaled: false, ratio: 1 }
      }
      throw err2
    }
  }
}

// 2:1씩 절반으로 반복 축소 후 마지막에 목표 크기로 정확히 맞춘다.
// 각 중간 단계도 imageSmoothingQuality='high'로 그려 에일리어싱을 누적 완화한다.
function stepwiseDownscale(
  source: ImageBitmap | HTMLImageElement | AnyCanvas,
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): AnyCanvas {
  let curW = srcW
  let curH = srcH
  let curCanvas: AnyCanvas | null = null

  // 현재 원본(처음엔 비트맵/이미지, 이후엔 직전 캔버스)
  let cur: ImageBitmap | HTMLImageElement | AnyCanvas = source

  // 목표의 2배보다 크면 절반씩 줄인다.
  while (curW > targetW * 2 && curH > targetH * 2) {
    const nextW = Math.max(targetW, Math.floor(curW / 2))
    const nextH = Math.max(targetH, Math.floor(curH / 2))
    const { canvas, ctx } = makeCanvas(nextW, nextH)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(cur as CanvasImageSource, 0, 0, nextW, nextH)
    cur = canvas
    curCanvas = canvas
    curW = nextW
    curH = nextH
  }

  // 마지막 단계: 정확한 목표 크기로 그린다.
  const { canvas, ctx } = makeCanvas(targetW, targetH)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cur as CanvasImageSource, 0, 0, targetW, targetH)
  // curCanvas는 중간 산출물 — JS GC가 회수하므로 별도 해제 불필요(캔버스는 close 없음)
  void curCanvas
  return canvas
}
