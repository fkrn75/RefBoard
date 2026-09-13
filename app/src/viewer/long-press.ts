// 롱프레스(길게 누르기) 판정 — 순수 함수. touch.ts의 탭(TAP_MAX_MOVE/TAP_MAX_MS) 판정과 대칭 설계.
//
// 실제 타이머(setTimeout) 배선은 touch.ts가 담당하고, "지금 발동해도 되는가"라는 판정 자체는
// 여기서 순수하게(경과시간·이동거리·멀티터치 여부만으로) 계산한다 — 타이머/DOM 없이 단위 테스트 가능.
// 모바일에서 댓글 배지가 없는 이미지 위에서도 롱프레스로 댓글을 노출하는 데 사용(main.ts onLongPress).

export const LONG_PRESS_MS = 400 // 이 시간(ms) 이상 눌려 있으면 롱프레스
export const LONG_PRESS_MAX_MOVE_PX = 10 // 이 이상 움직이면 팬/스크롤로 간주해 취소(탭의 TAP_MAX_MOVE와 동일 값)

// 지금 시점에 롱프레스로 판정해도 되는지.
//  - elapsedMs: 포인터가 눌린 후 경과 시간
//  - movedPx: 시작점 대비 누적 이동량(touch.ts의 tapMoved와 동일 지표)
//  - multiTouched: 이 제스처 동안 2손가락(핀치)이 한 번이라도 관측됐는지(핀치는 롱프레스 아님)
export function isLongPress(elapsedMs: number, movedPx: number, multiTouched: boolean): boolean {
  return !multiTouched && movedPx <= LONG_PRESS_MAX_MOVE_PX && elapsedMs >= LONG_PRESS_MS
}
