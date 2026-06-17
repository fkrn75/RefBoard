// 보드 입출력(.refb) — 데스크탑/웹 공통 직렬화 경로를 파일 다운로드·업로드로 연결한다.
// 실제 직렬화 포맷은 board.ts(serialize/deserialize)가 단일 진실 공급원이며, 여기서는
// 그 JSON 문자열을 브라우저 파일 시스템(.refb Blob ↔ File)으로만 옮긴다.

import { serialize, deserialize, type BoardState } from './board'

// .refb 확장자 + JSON MIME 타입. (.refb는 현재 평문 JSON; 추후 ZIP 패킹 시 이 모듈만 교체)
const REFB_EXT = '.refb'
const REFB_MIME = 'application/json'

// 보드 제목 → 안전한 파일명 베이스로 변환 (공백→_, 비어 있으면 'board')
function toFileBase(title: string | undefined): string {
  const base = (title ?? '').trim().replace(/\s+/g, '_')
  return base || 'board'
}

/**
 * 보드를 .refb 파일로 저장한다.
 * serialize(board) 결과 JSON을 Blob으로 만들어 임시 <a download>로 다운로드시킨다.
 * @param board     저장할 보드 상태
 * @param filename  파일명(선택). 미지정 시 board.board.title 기반 + .refb
 */
export function saveBoard(board: BoardState, filename?: string): void {
  const json = serialize(board)
  const blob = new Blob([json], { type: REFB_MIME })
  const url = URL.createObjectURL(blob)

  // 파일명 결정: 명시값 우선, 없으면 보드 제목 기반. .refb 확장자는 항상 보장.
  let name = filename ?? `${toFileBase(board.board?.title)}${REFB_EXT}`
  if (!name.toLowerCase().endsWith(REFB_EXT)) name += REFB_EXT

  const a = document.createElement('a')
  a.href = url
  a.download = name
  // 일부 브라우저는 DOM에 붙어 있어야 click이 동작 → 붙였다 즉시 제거.
  document.body.appendChild(a)
  a.click()
  a.remove()

  // 다운로드 트리거 직후 objectURL 해제(메모리 누수 방지). click은 동기 처리됨.
  URL.revokeObjectURL(url)
}

/**
 * 선택된 .refb 파일을 읽어 BoardState로 복원한다.
 * FileReader로 텍스트를 읽어 deserialize하고, schema 필드가 'refboard/'로
 * 시작하는지 검증한다(아니면 throw). 파싱 실패 시에도 throw.
 * @param file  사용자가 선택한 파일
 * @returns     복원된 보드 상태
 */
export function loadBoardFile(file: File): Promise<BoardState> {
  return new Promise<BoardState>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(new Error('파일을 읽을 수 없습니다.'))
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '')
        const state = deserialize(text)
        // 최소 유효성 검증: refboard 스키마인지 확인. 잘못된 .refb/타 파일 차단.
        if (
          !state ||
          typeof state.schema !== 'string' ||
          !state.schema.startsWith('refboard/')
        ) {
          reject(new Error('유효한 RefBoard(.refb) 파일이 아닙니다.'))
          return
        }
        resolve(state)
      } catch {
        reject(new Error('보드 파일을 해석할 수 없습니다(손상되었거나 형식이 다름).'))
      }
    }
    reader.readAsText(file)
  })
}

/**
 * .refb 파일 선택 다이얼로그를 띄워 선택된 File을 반환한다(헬퍼).
 * 동적 <input type=file>을 사용하며, 사용자가 취소하면 null을 반환한다.
 * @returns 선택된 File, 취소 시 null
 */
export function pickRefbFile(): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.refb,application/json'
    input.onchange = () => {
      const file = input.files && input.files[0] ? input.files[0] : null
      resolve(file)
    }
    // 취소(파일 미선택 후 닫기)는 표준 onchange 미발생 → 안전한 폴백을 둔다.
    // window 포커스 복귀 후에도 선택이 없으면 null로 간주.
    window.addEventListener(
      'focus',
      () => {
        // 다음 틱에 onchange가 먼저 처리될 기회를 준 뒤 미선택이면 null.
        setTimeout(() => {
          if (!input.files || input.files.length === 0) resolve(null)
        }, 300)
      },
      { once: true },
    )
    input.click()
  })
}
