// 보드 입출력(.refb) — refb.ts(ZIP 컨테이너)를 브라우저 파일 시스템(업로드/다운로드)으로 연결한다.
// 실제 컨테이너 패킹/언패킹은 refb.ts가 담당하며, 여기서는 파일 선택·읽기와 스키마 검증만 맡는다.
// (저장 경로는 썸네일 렌더가 필요해 main.ts가 packRefb/downloadBlob을 직접 조립한다 — io는 열기 전담.)

import { type BoardState } from './board'
import { unpackRefb } from './refb'

/**
 * 선택된 .refb 파일을 읽어 BoardState로 복원한다.
 * ZIP 컨테이너(신포맷)와 평문 JSON(구버전)을 unpackRefb가 자동 감지해 처리하며,
 * 복원된 상태의 schema가 'refboard/'로 시작하는지 검증한다(아니면 throw).
 * @param file  사용자가 선택한 파일
 * @returns     복원된 보드 상태
 */
export async function loadBoardFile(file: File): Promise<BoardState> {
  const state = await unpackRefb(file)
  // 최소 유효성 검증: refboard 스키마인지 확인. 잘못된 .refb/타 파일 차단.
  if (
    !state ||
    typeof state.schema !== 'string' ||
    !state.schema.startsWith('refboard/')
  ) {
    throw new Error('유효한 RefBoard(.refb) 파일이 아닙니다.')
  }
  return state
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
    input.accept = '.refb,application/zip,application/json'
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
