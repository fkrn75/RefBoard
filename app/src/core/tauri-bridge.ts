// Tauri 데스크탑 환경 연동 — 네이티브 파일 I/O + 윈도우 모드(PureRef 정체성).
//
// 설계 원칙:
//  - 웹(브라우저)에서는 isDesktop()=false. 호출측은 이 값으로 분기해 웹 폴백(다운로드/<input>)을 쓴다.
//  - Tauri 플러그인/윈도우 API는 동적 import로 불러온다. 웹 번들에 정적으로 박지 않아
//    브라우저에서 불필요한 로드를 피하고, 데스크탑에서만 실제 IPC가 일어난다.
//  - 모든 함수는 데스크탑 가정. 웹에서 잘못 불러도 throw가 새지 않게 호출측이 isDesktop()로 가드한다.

import { isTauri } from '@tauri-apps/api/core'

// 현재 Tauri(데스크탑) 환경인지. 브라우저면 false.
export function isDesktop(): boolean {
  try {
    return isTauri()
  } catch {
    return false
  }
}

// .refb 네이티브 저장: 저장 다이얼로그 → 파일 쓰기. 저장 경로 반환(취소 시 null).
export async function saveRefbNative(bytes: Uint8Array, defaultName: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: 'RefBoard', extensions: ['refb'] }],
  })
  if (!path) return null
  await writeFile(path, bytes)
  return path
}

// .refb 네이티브 열기: 열기 다이얼로그 → 파일 읽기. {bytes, name} 반환(취소 시 null).
export async function openRefbNative(): Promise<{ bytes: Uint8Array; name: string } | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'RefBoard', extensions: ['refb'] }],
  })
  if (typeof path !== 'string') return null // 취소 또는 다중선택(미사용)
  const bytes = await readFile(path)
  const name = path.replace(/^.*[\\/]/, '') // 경로에서 파일명만 추출
  return { bytes, name }
}

// ---- 윈도우 모드(PureRef 정체성) ----

// 항상 위 설정.
export async function setAlwaysOnTop(on: boolean): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().setAlwaysOnTop(on)
}

// 타이틀바/테두리 표시(false면 미니멀 무테 창).
export async function setDecorations(on: boolean): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().setDecorations(on)
}

// 마우스 통과(클릭스루) — 켜면 창이 포인터 입력을 받지 않아 아래 앱으로 클릭이 통과한다(트레이싱용).
// 키보드 이벤트는 영향받지 않으므로 단축키로 다시 끌 수 있다.
export async function setClickThrough(on: boolean): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().setIgnoreCursorEvents(on)
}

// 항상 아래(다른 창 뒤로 — 바탕화면 위 레퍼런스용). 항상위와 배타적으로 토글하는 게 일반적.
export async function setAlwaysOnBottom(on: boolean): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().setAlwaysOnBottom(on)
}

// 창 불투명도(0~1). Tauri 코어에 set-opacity 권한이 없어 Rust 커스텀 커맨드 set_window_opacity로 위임한다.
// Windows는 레이어드 윈도우 알파로 적용, 타 OS/웹은 무시(폴백). 완전 투명으로 창이 사라지는 사고를 막아 하한 0.2.
export async function setWindowOpacity(opacity: number): Promise<void> {
  const o = Math.max(0.2, Math.min(1, opacity))
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_window_opacity', { opacity: o })
}

// OS 네이티브 파일 드롭. 웹 드롭과 달리 실제 파일 절대경로를 받는다(.refb·이미지 열기용).
// 반환값은 구독 해제 함수. 드롭 시 콜백에 경로 배열을 전달한다.
export async function onOsFileDrop(cb: (paths: string[]) => void): Promise<() => void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return await getCurrentWindow().onDragDropEvent((e) => {
    if (e.payload.type === 'drop') cb(e.payload.paths)
  })
}

// OS 드롭으로 받은 절대경로의 파일을 읽어 바이트로 반환(확장자 필터). 이미지/.refb 임포트에 사용.
export async function readDroppedFile(path: string): Promise<{ bytes: Uint8Array; name: string }> {
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const bytes = await readFile(path)
  const name = path.replace(/^.*[\\/]/, '')
  return { bytes, name }
}
