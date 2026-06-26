// .refb 컨테이너(ZIP) — 보드 상태 + 임베드 이미지 자산을 하나의 ZIP 파일로 패킹/언패킹한다.
// 직렬화 포맷 자체(board.json의 내용)는 board.ts(serialize/deserialize)가 단일 진실 공급원이며,
// 이 모듈은 그 JSON과 이미지 바이너리를 ZIP 컨테이너(파일/Blob)로 옮기는 역할만 한다.
//
// 컨테이너 구조(ZIP 내부):
//   board.json     — BoardState. 임베드된 이미지의 src는 ZIP 내부 상대경로(assets/<id>.<ext>)로 치환.
//   assets/<id>.<ext> — 임베드된 이미지 바이너리(data URL/원격 → 디코드한 바이트).
//   thumbnail.png  — (선택) 보드 미리보기. exporter가 만들어 준 PNG 바이트만 저장(여기서 생성하지 않음).
//   manifest.json  — 컨테이너 메타데이터(버전/생성시각/이미지 수). 상위호환 판단에 사용.
//
// 하위호환: 구버전 .refb(평문 JSON)도 unpackRefb가 자동 감지해 읽는다(첫 바이트 '{'면 평문, 'PK'면 ZIP).

import { serialize, deserialize, isImageItem, type BoardState } from './board'
import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from 'fflate'

// 컨테이너 버전 식별자. 미래에 구조가 바뀌면 숫자를 올린다(unpack은 상위 버전도 경고 후 읽기 시도).
const CONTAINER_VERSION = 'refboard-zip/1'

// ZIP 내부 자산 디렉터리 접두사.
const ASSETS_DIR = 'assets/'

// manifest.json 스키마(컨테이너 레벨 메타데이터).
interface RefbManifest {
  container: string // 'refboard-zip/1' 등
  createdAt: string // ISO 8601 생성 시각
  imageCount: number // 보드 내 이미지 아이템 수
}

// ── MIME ↔ 확장자 매핑 ─────────────────────────────────────────────────────
// data URL 디코드 시 mime→ext, 미상 mime은 png로 폴백(컨테이너 일관성 유지).
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
// 자산 파일 확장자 → mime. unpack 시 ext→mime으로 data URL 헤더를 재구성한다.
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

// mime 문자열 → 자산 확장자(미상은 png).
function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? 'png'
}
// 자산 파일명(또는 확장자) → mime(미상은 image/png).
function extToMime(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] ?? 'image/png'
}

// ── data URL 파싱/생성 ─────────────────────────────────────────────────────
interface DecodedDataUrl {
  mime: string // 예: 'image/png'
  bytes: Uint8Array // 디코드된 바이너리
}

// 문자열이 data URL인지 판별.
function isDataUrl(src: string): boolean {
  return src.startsWith('data:')
}
// 문자열이 원격(http/https) URL인지 판별.
function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

/**
 * base64 data URL → { mime, bytes } 디코드.
 * 'data:<mime>;base64,<payload>' 형태를 가정한다. base64가 아닌 data URL은 지원하지 않음(throw).
 */
function decodeDataUrl(src: string): DecodedDataUrl {
  // 'data:image/png;base64,AAAA...' → 헤더와 페이로드 분리.
  const comma = src.indexOf(',')
  if (comma < 0) throw new Error('잘못된 data URL(쉼표 없음)')
  const header = src.slice(5, comma) // 'data:' 5글자 건너뜀 → 'image/png;base64'
  const payload = src.slice(comma + 1)
  if (!/;base64/i.test(header)) {
    throw new Error('base64가 아닌 data URL은 지원하지 않습니다.')
  }
  const mime = header.split(';')[0] || 'image/png'

  // base64 → 바이너리. atob는 브라우저 표준(데스크탑/웹뷰어 모두 사용 가능).
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { mime, bytes }
}

/**
 * 바이너리 + mime → base64 data URL 문자열.
 * unpack 시 ZIP 내부 자산을 다시 인라인해 기존 렌더 경로(src=data URL)와 호환시킨다.
 */
function encodeDataUrl(bytes: Uint8Array, mime: string): string {
  // 바이트 → 바이너리 문자열 → base64. 큰 이미지에서 call stack 초과를 피하려고 청크 단위 처리.
  let binary = ''
  const chunk = 0x8000 // 32KB씩 끊어 String.fromCharCode에 전달
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    )
  }
  return `data:${mime};base64,${btoa(binary)}`
}

// 🔴 손상 방어의 핵심: 바이트가 실제 이미지인지 매직바이트(파일 시그니처)로 판별한다.
// content-type 헤더는 못 믿는다 — Cloudflare Pages SPA fallback이 index.html(HTML)을 돌려주거나
// 서버가 image/png로 거짓 라벨링해도, 바이트 시그니처는 속일 수 없다. 래스터(PNG/JPEG/GIF/WebP/BMP)와
// SVG(텍스트 '<?xml'/'<svg')는 허용하고, HTML('<!doctype'/'<html' 등)·일반 텍스트는 거부한다.
function looksLikeImageBytes(b: Uint8Array): boolean {
  if (!b || b.length < 4) return false
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true // 'GIF8'
  if (b[0] === 0x42 && b[1] === 0x4d) return true // BMP 'BM'
  // WebP: 'RIFF' .... 'WEBP'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return true
  // SVG(텍스트): 선행 공백/BOM 건너뛰고 '<?'(xml) 또는 '<s'/'<S'(svg)면 허용. '<!'(doctype)·'<h'(html)는 거부.
  let i = 0
  while (
    i < b.length &&
    (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0xef || b[i] === 0xbb || b[i] === 0xbf)
  )
    i++
  if (b[i] === 0x3c && (b[i + 1] === 0x3f || b[i + 1] === 0x73 || b[i + 1] === 0x53)) return true
  return false
}

// 매직바이트로 image mime 추정(이미지가 아니면 null). data URL 헤더 재구성용.
function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'image/webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  return null
}

// 원격/상대 URL을 fetch해 { mime, bytes }로 가져온다(원격 이미지 임베드용).
// 이미지가 아닌 응답(CF SPA fallback HTML 등)은 throw해 비-이미지가 자산으로 굳는 것을 막는다.
async function fetchRemoteImage(url: string): Promise<DecodedDataUrl> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`원격 이미지를 가져올 수 없습니다(${res.status}): ${url}`)
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  // content-type이 이미지가 아니면(text/html 등) 즉시 거부.
  if (ct && !ct.startsWith('image/')) throw new Error(`이미지가 아닌 응답(${ct}): ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  // content-type을 속여도(헤더 image/* + 본문 HTML) 매직바이트로 최종 차단.
  if (!looksLikeImageBytes(bytes)) throw new Error(`이미지 시그니처 불일치(손상/HTML): ${url}`)
  const mime = ct.startsWith('image/') ? ct : (sniffImageMime(bytes) ?? 'image/png')
  return { mime, bytes }
}

// 자산 파일명에서 확장자만 추출(점 뒤). 없으면 빈 문자열.
function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1) : ''
}

// 아이템이 이미지(src를 가진) 타입인지 좁히기는 board.ts의 isImageItem(SSOT)을 사용한다.
// 노트(BoardNote)·드로잉(BoardDrawing)은 자산(바이너리 src)이 없으므로 이 가드로 걸러져
// board.json에 그대로 보존된다(자산화 루프를 건너뜀 → 직렬화 왕복에서 데이터 무손실).

// ── pack ───────────────────────────────────────────────────────────────────
/**
 * 보드를 .refb(ZIP 컨테이너) Blob으로 패킹한다.
 *
 * 임베드 규칙:
 *  - data URL(스크린샷/붙여넣기)·원격(http/https) 이미지는 mode와 무관하게 **항상 임베드**.
 *  - 로컬 파일 링크(file:// 등 그 외 경로)는 link 모드에서만 경로를 유지(임베드 생략).
 *    embed 모드에서는 로컬 링크도 임베드하려 시도하나, 브라우저에서 임의 파일 경로를 fetch할 수
 *    없으므로 사실상 불가 → 경로를 그대로 둔다(원본 board는 절대 변경하지 않음).
 *
 * @param board 저장할 보드 상태(이 함수는 board를 변경하지 않음 — 깊은 복사본에서만 src 치환)
 * @param opts.mode      'embed'(기본): 가능한 이미지를 ZIP에 임베드 / 'link': 로컬 경로 유지
 * @param opts.thumbnail (선택) 보드 미리보기 PNG 바이트. exporter가 만들어 전달(여기선 생성 안 함)
 * @returns .refb ZIP 컨테이너 Blob(application/zip)
 */
export async function packRefb(
  board: BoardState,
  opts?: { mode?: 'embed' | 'link'; thumbnail?: Uint8Array },
): Promise<Blob> {
  // 참고: opts.mode('embed'/'link')는 더 이상 분기에 쓰이지 않는다 — 브라우저는 임의 로컬 경로를
  // fetch할 수 없어 embed든 link든 data URL/http(s)만 임베드하고 나머지는 경로를 유지하기 때문이다.
  // (시그니처에는 하위호환으로 남겨 둔다.)

  // 원본 board를 변경하지 않기 위해 board.json용 깊은 복사본을 만든다.
  // (structuredClone 우선, 미지원 환경은 JSON 라운드트립 폴백.)
  const cloned: BoardState =
    typeof structuredClone === 'function'
      ? structuredClone(board)
      : (JSON.parse(serialize(board)) as BoardState)

  // ZIP 엔트리 모음. board.json/manifest.json/assets·thumbnail을 채운다.
  const entries: Zippable = {}

  let imageCount = 0
  // 각 이미지 아이템을 순회하며, 임베드 대상이면 바이트를 디코드해 assets/에 넣고
  // 복사본의 src를 ZIP 내부 상대경로로 치환한다.
  for (const item of cloned.items) {
    if (!isImageItem(item)) continue
    imageCount++

    const src = item.src
    let decoded: DecodedDataUrl | null = null

    if (isDataUrl(src)) {
      // data URL → 임베드. base64가 아닌 data URL(SVG 텍스트 등)은 decodeDataUrl이 throw하므로
      // try/catch로 감싸 저장 전체가 실패하지 않게 한다(링크 유지로 폴백 — bug-io P2).
      try {
        decoded = decodeDataUrl(src)
      } catch {
        decoded = null
      }
    } else if (isRemoteUrl(src)) {
      // 원격 http(s) URL → 임베드 시도(네트워크에서 받아옴). 실패/비이미지면 링크 유지로 폴백.
      try {
        decoded = await fetchRemoteImage(src)
      } catch {
        decoded = null
      }
    }
    // ⚠️ 그 외(빈 문자열·Storage 키·상대경로·로컬 파일경로)는 절대 fetch하지 않는다.
    // fetch('')나 fetch('키/상대경로')는 브라우저가 origin 기준 상대경로로 해석 → CF Pages SPA
    // fallback(index.html=HTML)을 받아 비-이미지를 assets/<id>.png로 굳히던 손상의 발원지였다.
    // 이 경우 src를 그대로 두고, board.json의 srcs(있으면)가 표시를 담당한다.

    // 디코드 결과가 실제 이미지인지 매직바이트로 최종 검증 — 아니면 임베드하지 않는다(손상 자산 방지).
    if (decoded && !looksLikeImageBytes(decoded.bytes)) {
      console.warn(`[refb] 임베드 대상이 이미지가 아님 — 건너뜀(item ${item.id}).`)
      decoded = null
    }

    if (decoded) {
      // mime은 매직바이트 우선(헤더 거짓 라벨 방지), 보조로 decoded.mime.
      const mime = sniffImageMime(decoded.bytes) ?? decoded.mime
      const ext = mimeToExt(mime)
      const assetPath = `${ASSETS_DIR}${item.id}.${ext}`
      entries[assetPath] = decoded.bytes
      item.src = assetPath // 복사본의 src를 ZIP 내부 상대경로로 치환.
    }
  }

  // board.json: src가 치환된 복사본을 직렬화해 저장.
  entries['board.json'] = strToU8(serialize(cloned))

  // manifest.json: 컨테이너 메타데이터.
  const manifest: RefbManifest = {
    container: CONTAINER_VERSION,
    createdAt: new Date().toISOString(),
    imageCount,
  }
  entries['manifest.json'] = strToU8(JSON.stringify(manifest))

  // thumbnail.png: exporter가 만들어 준 PNG 바이트가 있으면 저장(없으면 생략).
  if (opts?.thumbnail && opts.thumbnail.length > 0) {
    entries['thumbnail.png'] = opts.thumbnail
  }

  // 동기 ZIP 생성. 이미지(이미 압축된 png/jpg 등)는 재압축 이득이 적으므로 level 0(store)로
  // 두면 속도가 빠르지만, fflate 기본(level 6)도 충분히 빠르고 board.json 압축 이득이 있다.
  const zipped = zipSync(entries)

  // ZIP 바이트 → Blob(application/zip). saveBoard 쪽에서 다운로드/저장에 사용.
  return new Blob([zipped as BlobPart], { type: 'application/zip' })
}

// ── unpack ───────────────────────────────────────────────────────────────────
/**
 * .refb Blob을 BoardState로 언패킹한다.
 *
 * 컨테이너(ZIP)면 board.json을 읽고 assets/를 다시 data URL로 인라인해 기존 렌더 경로와 호환.
 * 평문 JSON(구버전 .refb)이면 그대로 deserialize한다(첫 바이트로 자동 감지).
 *
 * @param blob .refb 파일 Blob
 * @returns 복원된 보드 상태(이미지 src는 data URL로 인라인됨)
 */
export async function unpackRefb(blob: Blob): Promise<BoardState> {
  const bytes = new Uint8Array(await blob.arrayBuffer())

  // 매직바이트로 컨테이너/평문 구분: 'PK'(0x50 0x4B)=ZIP, '{'(0x7B)=평문 JSON.
  // 선행 공백을 건너뛰고 첫 의미 있는 바이트를 본다(평문 JSON이 공백으로 시작하는 경우 대비).
  let i = 0
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
    i++
  }
  const isZip = bytes[i] === 0x50 && bytes[i + 1] === 0x4b // 'P','K'

  if (!isZip) {
    // 구버전 평문 .refb → 텍스트로 디코드해 그대로 역직렬화.
    const text = strFromU8(bytes)
    return deserialize(text)
  }

  // ZIP 컨테이너 해제.
  const files = unzipSync(bytes)

  // manifest 확인(상위호환): 미래 container 버전이면 경고만 하고 읽기를 계속 시도한다.
  if (files['manifest.json']) {
    try {
      const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Partial<RefbManifest>
      if (manifest.container && manifest.container !== CONTAINER_VERSION) {
        console.warn(
          `[refb] 알 수 없는 컨테이너 버전(${manifest.container}). ${CONTAINER_VERSION}로 읽기를 시도합니다.`,
        )
      }
    } catch {
      // manifest 파싱 실패는 치명적이지 않음 → 무시하고 board.json 읽기 진행.
    }
  }

  // board.json 필수.
  const boardJson = files['board.json']
  if (!boardJson) {
    throw new Error('유효한 RefBoard 컨테이너가 아닙니다(board.json 없음).')
  }
  const state = deserialize(strFromU8(boardJson))

  // assets/ 자산을 data URL로 다시 인라인해 src를 복원(기존 렌더 경로 호환).
  // 손상된 board.json(items가 배열이 아님)이면 순회가 "is not iterable"로 크래시하므로 가드한다(bug-io P2).
  // 스키마 유효성(refboard/...)은 호출측 io.ts가 별도 검증한다.
  if (Array.isArray(state.items)) for (const item of state.items) {
    if (!isImageItem(item)) continue
    const src = item.src
    // ZIP 내부 상대경로(assets/...)로 치환돼 있던 것만 복원 대상.
    if (!src.startsWith(ASSETS_DIR)) continue
    const asset = files[src]
    if (!asset) {
      // 자산이 누락된 손상 컨테이너: 경고만 하고 경로를 그대로 둔다(전체 로드는 계속).
      console.warn(`[refb] 자산 누락: ${src} (이미지 src를 복원하지 못했습니다).`)
      continue
    }
    // 🔴 손상 방어: 자산 바이트가 실제 이미지인지 매직바이트로 검증한다. 확장자(.png)만 믿고
    // HTML 바이트를 image/png data URL로 둔갑시키던 것이 손상의 발원지였다(CF SPA fallback이
    // assets/<id>.png로 저장된 경우 등). 비-이미지면 src를 비워(손상 dataURL을 만들지 않음)
    // 자가 치유한다 — board.json의 srcs(있으면)가 표시를 담당하므로 정상 이미지는 그대로 보인다.
    if (!looksLikeImageBytes(asset)) {
      console.warn(`[refb] 자산이 이미지가 아님(손상/HTML): ${src} — src를 비웁니다(srcs로 폴백).`)
      item.src = ''
      continue
    }
    // mime은 매직바이트 우선(확장자 거짓 가능성 차단), 보조로 확장자.
    const mime = sniffImageMime(asset) ?? extToMime(extOf(src))
    item.src = encodeDataUrl(asset, mime)
  }

  return state
}
