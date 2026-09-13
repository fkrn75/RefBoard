import { describe, expect, it } from 'vitest'
import { isLongPress, LONG_PRESS_MAX_MOVE_PX, LONG_PRESS_MS } from './long-press'

describe('isLongPress', () => {
  it('임계 시간 이상 + 거의 안 움직였으면 롱프레스', () => {
    expect(isLongPress(LONG_PRESS_MS, 0, false)).toBe(true)
    expect(isLongPress(LONG_PRESS_MS + 50, LONG_PRESS_MAX_MOVE_PX, false)).toBe(true)
  })

  it('임계 시간 미만이면 아직 롱프레스 아님', () => {
    expect(isLongPress(LONG_PRESS_MS - 1, 0, false)).toBe(false)
  })

  it('이동량이 임계값을 넘으면(팬/스크롤로 간주) 롱프레스 아님', () => {
    expect(isLongPress(LONG_PRESS_MS + 100, LONG_PRESS_MAX_MOVE_PX + 1, false)).toBe(false)
  })

  it('제스처 중 핀치(멀티터치)가 있었으면 롱프레스 아님', () => {
    expect(isLongPress(LONG_PRESS_MS + 100, 0, true)).toBe(false)
  })
})
