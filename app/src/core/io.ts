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
  return loadBoardBlob(file)
}

/**
 * Blob/바이트(.refb)를 읽어 BoardState로 복원한다(Tauri 네이티브 읽기 경로 공용).
 * File도 Blob이므로 loadBoardFile이 이 함수를 그대로 사용한다.
 * @param blob  .refb 컨테이너(ZIP) 또는 구버전 평문 JSON Blob
 * @returns     복원·검증된 보드 상태
 */
export async function loadBoardBlob(blob: Blob): Promise<BoardState> {
  const state = await unpackRefb(blob)
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
    // resolve는 단 한 번만(onchange·cancel·focus 폴백이 경합해도 첫 결과만 채택 — bug-io P1).
    let settled = false
    const done = (f: File | null) => {
      if (settled) return
      settled = true
      resolve(f)
    }
    input.onchange = () => done(input.files && input.files[0] ? input.files[0] : null)
    // 표준 cancel 이벤트(지원 브라우저)는 취소를 정확히 알려준다 → 폴백보다 우선.
    input.oncancel = () => done(null)
    // 폴백: 포커스 복귀 후에도 onchange/cancel이 없으면 취소로 간주.
    // settled 플래그 덕에 느린 디스크에서 onchange가 늦게 와도 "취소 오판"하지 않는다(500ms 여유).
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!input.files || input.files.length === 0) done(null)
        }, 500)
      },
      { once: true },
    )
    input.click()
  })
}
