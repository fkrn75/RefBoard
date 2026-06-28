// 이미지 내보내기 — PixiJS v8 renderer.extract로 씬/선택/개별 아이템을 PNG·JPG로 추출한다.
//
// 설계 원칙(단일 writer / 순수 함수):
//  - 이 모듈은 Scene에 직접 의존하지 않는다. renderer·world(Container)·대상 sprite를 "인자"로 받는다.
//    통합 시 team-lead가 scene.app.renderer / scene.world / scene.getSprite 를 넘겨 연결한다.
//  - 추출 frame은 항상 "world(부모 컨테이너)의 로컬 좌표"로 계산한다. extract의 frame 옵션이
//    target(=world)의 로컬 좌표계를 기준으로 하기 때문(카메라 줌/팬과 무관하게 원본 픽셀 기준 추출).
//  - 크롭은 비파괴로 sprite.texture frame에 이미 반영돼 렌더되므로(자동), 추출 결과에 그대로 포함된다.
//
// PixiJS v8 extract API (renderer.extract):
//  - canvas(opts): ICanvas      — 동기. opts={ target, frame?, resolution?, clearColor?, antialias? }
//  - pixels / image / base64 등도 있으나, Blob(.toBlob) 경로가 필요해 canvas를 채택.

import { Container, Rectangle, Bounds, type Renderer, type Sprite } from 'pixi.js'

// 내보내기 포맷. png=무손실/투명 보존, jpg=손실/배경 합성 필요, bmp=무압축(직접 인코딩).
export type ExportFormat = 'png' | 'jpg' | 'bmp'

// 공통 옵션.
export interface ExportOptions {
  format?: ExportFormat // 기본 'png'
  scale?: number // 해상도 배율(>1이면 더 선명/큰 이미지). 기본 1
  bg?: string // JPG 배경색(투명→검정 방지). 기본 '#ffffff'. png에선 무시(투명 유지)
  padding?: number // 추출 영역 가장자리 여백(world 로컬 px). 기본 0
}

// 포맷별 MIME. jpg는 image/jpeg, bmp는 image/bmp.
function mimeOf(format: ExportFormat): string {
  if (format === 'jpg') return 'image/jpeg'
  if (format === 'bmp') return 'image/bmp'
  return 'image/png'
}

// jpg 품질(0~1). 무손실 png에는 미적용.
const JPG_QUALITY = 0.92

// 옵션 정규화(기본값 채우기). scale은 [0.01, 8]로 클램프(0/음수 방지 + 비정상 대값 OOM 방지).
function normalize(opts: ExportOptions | undefined): Required<ExportOptions> {
  const o = opts ?? {}
  return {
    format: o.format ?? 'png',
    scale: Math.min(8, Math.max(0.01, o.scale ?? 1)),
    bg: o.bg ?? '#ffffff',
    padding: Math.max(0, o.padding ?? 0),
  }
}

// ICanvas(HTMLCanvasElement | OffscreenCanvas)를 Blob으로 변환.
// 브라우저 캔버스는 toBlob을, OffscreenCanvas는 convertToBlob을 제공한다(둘 다 폴백 처리).
function canvasToBlob(
  canvas: { toBlob?: (cb: (b: Blob | null) => void, type?: string, quality?: number) => void; convertToBlob?: (o?: { type?: string; quality?: number }) => Promise<Blob> },
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob이 null을 반환했습니다.'))),
        type,
        quality,
      )
    } else if (typeof canvas.convertToBlob === 'function') {
      canvas.convertToBlob({ type, quality }).then(resolve, reject)
    } else {
      reject(new Error('이 환경의 캔버스는 toBlob/convertToBlob을 지원하지 않습니다.'))
    }
  })
}

// ---- BMP 무압축 인코더 ----
// canvas.toBlob('image/bmp')는 브라우저 표준이 아니라(대부분 미지원/png 폴백) 직접 인코딩한다.
// 형식: BITMAPFILEHEADER(14) + BITMAPINFOHEADER(40) + 픽셀 데이터.
//   - 24bit BGR, bottom-up(마지막 행부터 저장), 각 행은 4바이트 경계로 패딩.
//   - 알파는 BMP 24bit가 표현 못 하므로, png/jpg와 달리 불투명 RGB만 기록(투명은 무시).
//     (투명 보존이 필요하면 png를 쓰는 게 맞음 — bmp는 무압축 RGB 산출이 목적.)

// ICanvas에서 2D 컨텍스트로 ImageData(RGBA)를 추출한다. width/height는 캔버스 픽셀 크기.
function canvasToImageData(canvas: {
  width: number
  height: number
  getContext: (id: '2d') => unknown
}): ImageData {
  const ctx = canvas.getContext('2d') as
    | (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D)
    | null
  if (!ctx) throw new Error('BMP 인코딩: 2D 컨텍스트를 얻지 못했습니다.')
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

// RGBA ImageData → 무압축 24bit BMP 바이트 배열.
function encodeBmp(image: ImageData): Uint8Array {
  const { width, height, data } = image
  // 각 행 바이트 = 폭*3, 4바이트 정렬을 위한 패딩 추가.
  const rowBytes = width * 3
  const rowPadded = (rowBytes + 3) & ~3 // 4의 배수로 올림
  const pixelArraySize = rowPadded * height
  const fileHeaderSize = 14
  const infoHeaderSize = 40
  const offset = fileHeaderSize + infoHeaderSize // 픽셀 데이터 시작 오프셋
  const fileSize = offset + pixelArraySize

  const buf = new ArrayBuffer(fileSize)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  // ── BITMAPFILEHEADER (14바이트, 리틀엔디언) ──
  view.setUint8(0, 0x42) // 'B'
  view.setUint8(1, 0x4d) // 'M'
  view.setUint32(2, fileSize, true) // 전체 파일 크기
  view.setUint32(6, 0, true) // 예약(0)
  view.setUint32(10, offset, true) // 픽셀 데이터까지의 오프셋

  // ── BITMAPINFOHEADER (40바이트) ──
  view.setUint32(14, infoHeaderSize, true) // 헤더 크기(40)
  view.setInt32(18, width, true) // 폭
  view.setInt32(22, height, true) // 높이(양수=bottom-up)
  view.setUint16(26, 1, true) // 평면 수(항상 1)
  view.setUint16(28, 24, true) // 비트/픽셀(24bit BGR)
  view.setUint32(30, 0, true) // 압축 없음(BI_RGB=0)
  view.setUint32(34, pixelArraySize, true) // 픽셀 데이터 크기
  view.setInt32(38, 2835, true) // 가로 해상도(픽셀/미터, 72dpi≈2835)
  view.setInt32(42, 2835, true) // 세로 해상도
  view.setUint32(46, 0, true) // 팔레트 색 수(0=기본)
  view.setUint32(50, 0, true) // 중요 색 수(0=전부)

  // ── 픽셀 데이터: bottom-up(맨 아래 행부터), BGR 순, 행 끝 패딩 ──
  let p = offset
  for (let y = height - 1; y >= 0; y--) {
    let rowStart = y * width * 4 // RGBA 소스의 해당 행 시작 인덱스
    for (let x = 0; x < width; x++) {
      // BMP는 BGR 순서. 알파는 무시(불투명 RGB만).
      bytes[p++] = data[rowStart + 2] // B
      bytes[p++] = data[rowStart + 1] // G
      bytes[p++] = data[rowStart] // R
      rowStart += 4
    }
    // 행 패딩(0으로 채움)으로 4바이트 경계 정렬.
    for (let pad = rowBytes; pad < rowPadded; pad++) bytes[p++] = 0
  }

  return bytes
}

// ICanvas → BMP Blob. ImageData를 뽑아 encodeBmp로 바이트화한 뒤 Blob으로 감싼다.
function canvasToBmpBlob(canvas: {
  width: number
  height: number
  getContext: (id: '2d') => unknown
}): Blob {
  const image = canvasToImageData(canvas)
  const bytes = encodeBmp(image)
  // TS 5.7 lib에서 Uint8Array<ArrayBufferLike>는 BlobPart에 직접 안 맞으므로
  // 백킹 ArrayBuffer를 잘라(복사 1회) 넘긴다(main.ts 다운로드 경로와 동일 패턴).
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([buf], { type: 'image/bmp' })
}

// 여러 sprite의 합집합 경계를 "world(부모) 로컬 좌표"의 Rectangle로 구한다.
// 각 sprite의 자기-로컬 경계(getLocalBounds)를 localTransform(=부모 좌표로의 투영)으로 변환해 누적.
// 대상이 비었거나 경계가 비정상(빈 Bounds)이면 null.
function unionFrame(sprites: Sprite[], padding: number): Rectangle | null {
  if (sprites.length === 0) return null
  const bounds = new Bounds()
  for (const s of sprites) {
    // getLocalBounds(): sprite 자신 좌표계의 경계(크롭 반영된 texture 크기 기준).
    // localTransform: sprite-로컬 → 부모(world)-로컬 투영 행렬.
    bounds.addBounds(s.getLocalBounds(), s.localTransform)
  }
  if (!Number.isFinite(bounds.minX) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    return null
  }
  const r = bounds.rectangle
  if (padding > 0) {
    r.x -= padding
    r.y -= padding
    r.width += padding * 2
    r.height += padding * 2
  }
  return r
}

// extract.canvas 공통 호출 → Blob. jpg는 clearColor로 배경을 칠해 투명 영역의 검정화를 막는다.
// frame=null이면 target 전체 경계를 Pixi가 자동 산정(주로 world 전체 = 씬 전체).
async function extractBlob(
  renderer: Renderer,
  target: Container,
  frame: Rectangle | null,
  o: Required<ExportOptions>,
): Promise<Blob> {
  const canvas = renderer.extract.canvas({
    target,
    ...(frame ? { frame } : {}),
    resolution: o.scale,
    // png은 투명 유지(clearColor 미지정), jpg/bmp는 배경색으로 클리어(둘 다 투명 미보존).
    ...(o.format === 'jpg' || o.format === 'bmp' ? { clearColor: o.bg } : {}),
  })
  // bmp는 toBlob 미지원이므로 직접 인코딩(ImageData→무압축 24bit BMP).
  if (o.format === 'bmp') {
    return canvasToBmpBlob(canvas as { width: number; height: number; getContext: (id: '2d') => unknown })
  }
  const mime = mimeOf(o.format)
  return canvasToBlob(canvas, mime, o.format === 'jpg' ? JPG_QUALITY : undefined)
}

/**
 * 단일 대상(Container/Sprite)을 그대로 Blob으로 내보낸다(가장 낮은 수준의 진입점).
 * frame을 지정하지 않으므로 Pixi가 target 전체 경계를 자동으로 잡는다.
 * @param renderer  scene.app.renderer
 * @param target    추출 대상(Container). 보통 world 또는 단일 sprite
 * @param opts      포맷/배율/배경
 */
export async function exportToBlob(
  renderer: Renderer,
  target: Container,
  opts?: ExportOptions,
): Promise<Blob> {
  return extractBlob(renderer, target, null, normalize(opts))
}

/**
 * 씬 전체(world의 모든 콘텐츠 경계)를 한 장으로 내보낸다.
 * 주의: 통합 시 team-lead가 오버레이(선택 외곽선/기즈모/그리드) 레이어를 잠시 숨긴 world를 넘기거나,
 *       콘텐츠만 담긴 컨테이너를 넘겨야 오버레이가 결과에 섞이지 않는다(이 모듈은 받은 대상을 그대로 추출).
 * @param renderer  scene.app.renderer
 * @param world     이미지들이 담긴 컨테이너(scene.world)
 * @param opts      포맷/배율/배경/여백
 */
export async function exportSceneAll(
  renderer: Renderer,
  world: Container,
  opts?: ExportOptions,
): Promise<Blob> {
  const o = normalize(opts)
  // padding이 있으면 world 전체 경계를 직접 계산해 여백을 더한 frame으로 추출.
  // padding=0이면 frame=null로 두어 Pixi 자동 경계 산정을 그대로 사용(가장 단순/정확).
  let frame: Rectangle | null = null
  if (o.padding > 0) {
    const b = world.getLocalBounds()
    if (Number.isFinite(b.minX) && b.maxX > b.minX) {
      frame = new Rectangle(b.minX - o.padding, b.minY - o.padding, b.width + o.padding * 2, b.height + o.padding * 2)
    }
  }
  return extractBlob(renderer, world, frame, o)
}

/**
 * 선택된 아이템들의 합집합 영역을 한 장으로 내보낸다.
 * 대상은 world(부모) 그대로 두고, 선택 sprite들의 union 경계를 frame으로 잘라 추출한다.
 * (world 전체를 렌더하되 frame 영역만 캡처 → 선택 밖 아이템이 frame에 겹치면 함께 보일 수 있음.
 *  PureRef류 "선택 영역 내보내기" 의미와 동일.)
 * @param renderer   scene.app.renderer
 * @param world      scene.world
 * @param ids        선택된 이미지 id 목록
 * @param getSprite  id→Sprite 조회 함수(scene.getSprite)
 * @param opts       포맷/배율/배경/여백
 * @returns          Blob. 유효 대상이 하나도 없으면 throw
 */
export async function exportSelection(
  renderer: Renderer,
  world: Container,
  ids: string[],
  getSprite: (id: string) => Sprite | undefined,
  opts?: ExportOptions,
): Promise<Blob> {
  const o = normalize(opts)
  const sprites = ids.map(getSprite).filter((s): s is Sprite => !!s)
  const frame = unionFrame(sprites, o.padding)
  if (!frame) throw new Error('내보낼 선택 항목이 없습니다.')
  return extractBlob(renderer, world, frame, o)
}

// 개별 내보내기 1건 결과.
export interface ExportEachResult {
  id: string
  blob: Blob
}

/**
 * 선택된 아이템들을 각각 개별 파일(Blob)로 내보낸다.
 * 각 sprite의 자기 경계만 frame으로 잡아 1장씩 추출한다(다른 아이템 미포함).
 * @param renderer   scene.app.renderer
 * @param world      scene.world (추출 대상 컨테이너; sprite는 이 안의 자식)
 * @param ids        대상 id 목록
 * @param getSprite  id→Sprite 조회 함수
 * @param opts       포맷/배율/배경/여백
 * @returns          {id, blob} 배열(존재하지 않는 id는 건너뜀)
 */
export async function exportEach(
  renderer: Renderer,
  world: Container,
  ids: string[],
  getSprite: (id: string) => Sprite | undefined,
  opts?: ExportOptions,
): Promise<ExportEachResult[]> {
  const o = normalize(opts)
  const out: ExportEachResult[] = []
  for (const id of ids) {
    const sprite = getSprite(id)
    if (!sprite) continue
    const frame = unionFrame([sprite], o.padding)
    if (!frame) continue
    const blob = await extractBlob(renderer, world, frame, o)
    out.push({ id, blob })
  }
  return out
}

/**
 * 보드 썸네일을 PNG 바이트(Uint8Array)로 렌더한다 — zipper의 packRefb(thumbnail) 인자용.
 * target 전체를 추출한 뒤, 긴 변이 maxPx를 넘으면 그 비율로 resolution을 낮춰 한 번에 작게 뽑는다.
 * (별도 리스케일 캔버스 없이 extract resolution만으로 축소 → 단순·정확.)
 * @param renderer  scene.app.renderer
 * @param target    썸네일로 담을 컨테이너(보통 scene.world)
 * @param maxPx     썸네일 긴 변 최대 픽셀. 기본 512
 * @returns         PNG 바이트 배열(Uint8Array). 빈 보드면 1x1 투명 PNG 수준의 최소 결과가 나올 수 있음
 */
export async function renderThumbnail(
  renderer: Renderer,
  target: Container,
  maxPx = 512,
): Promise<Uint8Array> {
  // target의 현재 경계(로컬)로 긴 변을 구해 축소 배율 산정.
  const b = target.getLocalBounds()
  const w = Math.max(1, b.maxX - b.minX)
  const h = Math.max(1, b.maxY - b.minY)
  const longest = Math.max(w, h)
  // longest > maxPx면 1 미만으로 축소, 작으면 1(확대하지 않음).
  const scale = longest > maxPx ? maxPx / longest : 1
  const canvas = renderer.extract.canvas({
    target,
    resolution: Math.max(0.01, scale),
    // 썸네일은 PNG(투명 유지) — 배경 합성 불필요.
  })
  const blob = await canvasToBlob(canvas, 'image/png')
  const buf = await blob.arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * Blob을 파일로 다운로드한다(io.ts의 <a download> 패턴 재사용).
 * objectURL을 만들어 임시 <a>를 클릭시키고 즉시 정리한다.
 * @param blob      저장할 Blob
 * @param filename  파일명(확장자 포함). 예: 'board.png'
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // 일부 브라우저는 DOM에 붙어 있어야 click이 동작 → 붙였다 즉시 제거.
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 일부 브라우저는 click 직후 동기 revoke 시 대용량 다운로드가 취소될 수 있어 다음 틱에 해제(bug-io P3).
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 포맷에 맞는 확장자를 파일명 베이스에 붙인다(헬퍼).
 * @param base    확장자 없는 파일명 베이스(예: 'board')
 * @param format  'png' | 'jpg' | 'bmp'
 */
export function withImageExt(base: string, format: ExportFormat): string {
  const ext = format === 'jpg' ? '.jpg' : format === 'bmp' ? '.bmp' : '.png'
  return base.toLowerCase().endsWith(ext) ? base : base + ext
}
