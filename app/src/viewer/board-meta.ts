// 보드 메타 패널 — RefBoard Phase 5(웹 공유) 읽기전용 뷰어.
//
// 공유된 보드의 제목·설명·작성자·이미지 수를 보여주는 상단/코너 패널 DOM을 만든다.
// 라이트박스(lightbox.ts)와 달리 오버레이가 아니라 뷰어 화면 위에 얹는 정보 패널이라,
// DOM 요소를 "반환"만 하고 마운트 위치는 호출측(web-viewer 진입점)이 정한다.
//
// 설계 원칙(command-palette.ts·lightbox.ts와 일관):
//  - 순수 DOM. PixiJS·캔버스·board 렌더와 무관. 표시에 필요한 최소 정보(meta)만 입력받는다.
//  - 스타일은 theme.ts의 공식 --rb-* CSS 변수를 직접 참조하고, applyTheme() 전에도
//    각 var()의 fallback(다크 톤)으로 정상 렌더된다.
//  - 접근성: 패널은 region 역할 + aria-label, 제목은 heading 역할을 준다.
//  - 싱글턴/전역 리스너가 없다(순수 빌더). 같은 meta로 여러 번 호출해도 독립 요소를 만든다.

// 패널에 표시할 보드 메타 정보(모두 표시에 필요한 최소형).
export interface BoardMeta {
  title: string // 보드 제목(필수)
  description?: string // 보드 설명(없으면 줄 자체를 생략)
  author?: string // 작성자(없으면 생략)
  count?: number // 이미지 수(없으면 생략, 0도 표시)
}

// 보드 메타 패널 DOM을 만들어 반환한다(마운트는 호출측 책임).
//  - 코너/상단에 띄우기 좋게 position 없이 만들고, 호출측이 컨테이너에 배치한다.
//    (필요하면 반환된 요소의 style.position/top/left를 호출측에서 덮어쓰면 된다.)
export function renderBoardMeta(meta: BoardMeta): HTMLElement {
  // 패널 컨테이너: 반투명 카드. region 역할로 보조기술이 영역으로 인식하게 한다.
  const panel = document.createElement('div')
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', '보드 정보')
  panel.style.cssText = [
    'box-sizing:border-box',
    'max-width:min(360px,80vw)',
    'display:flex',
    'flex-direction:column',
    'gap:6px',
    'padding:14px 16px',
    'border-radius:12px',
    'background:var(--rb-panel-bg, #252526)',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'box-shadow:0 8px 28px rgba(0,0,0,.4)',
    'font:14px system-ui,Segoe UI,sans-serif',
    // glass 테마의 반투명 panel-bg에 유리 질감을 준다(dark/light는 불투명이라 무해).
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
  ].join(';')

  // 제목(필수): heading 역할 + aria-level로 문서 구조를 명확히 한다.
  const titleEl = document.createElement('div')
  titleEl.setAttribute('role', 'heading')
  titleEl.setAttribute('aria-level', '1')
  titleEl.textContent = meta.title
  titleEl.style.cssText = [
    'font-size:16px',
    'font-weight:600',
    'line-height:1.3',
    'overflow-wrap:anywhere', // 긴 제목이 패널을 넘치지 않게.
  ].join(';')
  panel.appendChild(titleEl)

  // 설명(선택): 있으면 보조 톤으로 표시.
  if (meta.description) {
    const descEl = document.createElement('div')
    descEl.textContent = meta.description
    descEl.style.cssText = [
      'font-size:13px',
      'line-height:1.45',
      'color:var(--rb-text-dim, #777)',
      'overflow-wrap:anywhere',
    ].join(';')
    panel.appendChild(descEl)
  }

  // 메타 줄(작성자 · 이미지 수): 둘 다 선택. 하나라도 있으면 한 줄로 묶어 표시.
  const parts: string[] = []
  if (meta.author) parts.push(meta.author)
  if (typeof meta.count === 'number') {
    parts.push(`이미지 ${meta.count}개`)
  }
  if (parts.length > 0) {
    const metaLine = document.createElement('div')
    // 가운뎃점으로 구분(작성자 · 이미지 N개).
    metaLine.textContent = parts.join(' · ')
    metaLine.style.cssText = [
      'font-size:12px',
      'line-height:1.4',
      'color:var(--rb-text-dim, #777)',
      'overflow-wrap:anywhere',
    ].join(';')
    panel.appendChild(metaLine)
  }

  return panel
}
