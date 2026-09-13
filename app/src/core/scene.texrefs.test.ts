// TEX-LEAK 수정 단위 테스트: 참조카운트 순수 로직(TextureRefCounter)과 캐시 키 헬퍼(imageCacheKey)만 검증.
// PixiJS 렌더러(Application/Assets)는 인스턴스화하지 않는다 — 이 둘은 Scene 클래스에 의존하지 않는 순수 함수/클래스라
// jsdom에서도 렌더러 없이 바로 단위 테스트할 수 있다(감사 요청: "순수 로직은 PixiJS 실객체 없이 테스트 가능하게 분리").
import { describe, expect, it } from 'vitest'
import { imageCacheKey, TextureRefCounter } from './scene'

describe('imageCacheKey', () => {
  it('srcs.medium이 있으면 medium을 키로 쓴다(원본 src보다 우선)', () => {
    expect(imageCacheKey({ src: 'data:orig', srcs: { thumb: 't', medium: 'm', orig: 'o' } })).toBe('m')
  })

  it('srcs가 없으면 원본 src로 폴백한다(편집 보드·하위호환)', () => {
    expect(imageCacheKey({ src: 'data:orig' })).toBe('data:orig')
  })

  it('srcs는 있지만 medium이 없으면 src로 폴백한다(부분 srcs 방어)', () => {
    expect(imageCacheKey({ src: 'data:orig', srcs: {} as never })).toBe('data:orig')
  })
})

describe('TextureRefCounter', () => {
  it('단일 참조: retain 1회 후 release하면 마지막 참조라 true(해제 필요)', () => {
    const rc = new TextureRefCounter()
    rc.retain('k1')
    expect(rc.count('k1')).toBe(1)
    expect(rc.release('k1')).toBe(true)
    expect(rc.count('k1')).toBe(0)
  })

  it('복제(같은 key로 2회 retain): 첫 release는 false(아직 살아있는 참조 있음), 두 번째가 true', () => {
    const rc = new TextureRefCounter()
    rc.retain('shared')
    rc.retain('shared') // 복제본 추가
    expect(rc.count('shared')).toBe(2)
    expect(rc.release('shared')).toBe(false) // 원본 삭제 — 복제본이 아직 텍스처를 쓰므로 해제 금지
    expect(rc.count('shared')).toBe(1)
    expect(rc.release('shared')).toBe(true) // 복제본까지 삭제 — 이제 진짜 해제
    expect(rc.count('shared')).toBe(0)
  })

  it('등록된 적 없는 키를 release해도(방어적 상황) false를 반환하고 음수로 내려가지 않는다', () => {
    const rc = new TextureRefCounter()
    expect(rc.release('never-retained')).toBe(false)
    expect(rc.count('never-retained')).toBe(0)
  })

  it('서로 다른 key는 독립적으로 카운트된다', () => {
    const rc = new TextureRefCounter()
    rc.retain('a')
    rc.retain('b')
    rc.retain('b')
    expect(rc.release('a')).toBe(true)
    expect(rc.count('b')).toBe(2)
  })

  it('clear()는 모든 카운트를 리셋한다', () => {
    const rc = new TextureRefCounter()
    rc.retain('x')
    rc.retain('y')
    rc.clear()
    expect(rc.count('x')).toBe(0)
    expect(rc.count('y')).toBe(0)
    // clear 이후엔 등록된 적 없는 상태와 동일하므로 release는 false.
    expect(rc.release('x')).toBe(false)
  })
})
