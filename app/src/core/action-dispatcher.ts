// 키맵 액션 id → 동작 디스패처(단축키·툴바·커맨드 팔레트 공용 진입점). main.ts God-file 분리(7.3).
// 액션 맵(id→핸들러)은 main이 구성해 주입하고, 여기선 디스패치와 팔레트 연결만 담당한다.
// 액션 목록·팔레트 UI는 keymap/command-palette에 직접 의존한다(main을 거치지 않음).
import { openPalette } from './command-palette'
import { getActions } from './keymap'

export type ActionMap = Record<string, () => void>

export interface ActionDispatcherApi {
  // 액션 id를 실행한다(미등록 id는 무시).
  run(id: string): void
  // 현재 액션 목록으로 커맨드 팔레트를 연다(선택 시 run).
  openCommandPalette(): void
}

export function createActionDispatcher(actions: ActionMap): ActionDispatcherApi {
  const run = (id: string): void => {
    actions[id]?.()
  }
  return {
    run,
    openCommandPalette: () => openPalette(getActions(), run),
  }
}
