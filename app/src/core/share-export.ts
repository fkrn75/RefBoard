// 자기완결 HTML export — 보드를 "외부 의존 0"인 단일 HTML 파일 하나로 내보낸다.
// 서버 없이 어디서나(파일 더블클릭·이메일 첨부·USB) 열리는 공유 메커니즘의 1순위 경로다.
//
// 설계 원칙:
//   - 보드 데이터(BoardState)는 <script type="application/json" id="refboard-data"> 안에
//     그대로 직렬화해 임베드한다. 뷰어 스크립트가 이 노드를 읽어 렌더한다.
//   - 뷰어 IIFE 번들(team-lead가 web-viewer를 빌드해 만든 문자열)은 <script>로 인라인한다.
//     번들이 없으면 <!-- VIEWER_BUNDLE --> 자리표시 주석만 남겨, team-lead가 빌드 후 치환한다.
//   - 결과는 단 하나의 문자열. 외부 CSS/JS/이미지 참조가 없어야 진짜 "자기완결"이다.
//
// 이미지 임베드 책임 경계(중요):
//   이 모듈은 board를 받은 "그 상태 그대로" 직렬화만 한다. 즉 board.items[].src가
//   data URL(임베드)이면 자기완결이 보장되고, 로컬/원격 링크면 그 링크가 그대로 박힌다.
//   링크를 data URL로 끌어와 임베드(=자기완결 보장)하는 일은 호출측 책임이다.
//   refb.ts의 packRefb가 data URL/원격 fetch로 이미지를 임베드하는 패턴과 동일한 역할 분담이며,
//   여기서 다시 네트워크 fetch를 하지 않는 이유는 (1) 동기 함수로 두어 호출이 단순하고
//   (2) 임베드 정책(어떤 src를 끌어올지)을 호출측이 일관되게 통제하기 위함이다.

import { serialize, type BoardState } from './board'

// 임베드된 보드 데이터를 담는 <script> 노드의 고정 id. 뷰어가 이 id로 데이터를 찾는다.
// 뷰어(web-viewer)와 반드시 동일한 상수를 공유해야 하므로 여기서 export해 단일 진실로 둔다.
export const BOARD_DATA_ELEMENT_ID = 'refboard-data'

// 뷰어 번들이 주입될 자리표시 주석. team-lead가 빌드 산출물(IIFE)로 이 주석을 치환한다.
// (정확한 문자열이 후속 치환의 앵커이므로 상수로 고정.)
export const VIEWER_BUNDLE_PLACEHOLDER = '<!-- VIEWER_BUNDLE -->'

// buildSelfContainedHtml 옵션.
export interface BuildHtmlOptions {
  // team-lead가 빌드한 뷰어 IIFE 번들 문자열. <script>로 인라인된다.
  // 생략하면 VIEWER_BUNDLE_PLACEHOLDER 주석만 남아 후속 치환을 기다린다.
  viewerScript?: string
  // 문서 <title>. 생략하면 board.board.title(빈 값이면 'RefBoard')을 사용한다.
  title?: string
}

// HTML 특수문자를 이스케이프한다(title 등 텍스트 컨텍스트 삽입용).
// 직렬화 JSON은 별도로 '</' 시퀀스만 처리하므로 여기서는 일반 텍스트만 다룬다.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// U+2028(LINE SEPARATOR)/U+2029(PARAGRAPH SEPARATOR)를 매칭하는 정규식.
// 소스 코드에 이 문자를 raw로 넣으면 정규식 리터럴이 줄바꿈으로 끊기므로,
// RegExp 생성자에 \u 이스케이프 문자열로 전달해 문자 자체가 소스에 들어가지 않게 한다.
const RE_LS = new RegExp('\\u2028', 'g')
const RE_PS = new RegExp('\\u2029', 'g')

/**
 * JSON 문자열을 <script type="application/json"> 안에 안전하게 넣기 위해 escape한다.
 * 핵심 위협은 페이로드 안의 '</script>'가 스크립트 블록을 조기 종료시키는 것.
 * '<' 다음 '/'를 '<\/'로 바꾸면(JSON 문자열 안에서 '\/'는 '/'와 동치라 의미 불변)
 * 어떤 '</...>' 시퀀스도 태그로 해석되지 않는다. U+2028/U+2029도 함께 무력화한다.
 */
function escapeJsonForScript(json: string): string {
  return json
    .replace(/<\//g, '<\\/')
    .replace(RE_LS, '\\u2028')
    .replace(RE_PS, '\\u2029')
}

/**
 * 보드를 자기완결 단일 HTML 문자열로 빌드한다(서버 0, 외부 의존 0).
 *
 * 산출 구조:
 *   <head>  최소 메타 + 인라인 CSS(전체화면 캔버스/로딩 표시)
 *   <body>  #app(뷰어 마운트 지점) + 로딩 표시
 *           <script id="refboard-data" type="application/json">…BoardState…</script>
 *           <script>…뷰어 IIFE 번들…</script>   ← 또는 VIEWER_BUNDLE_PLACEHOLDER 주석
 *
 * @param board 내보낼 보드 상태. 이 함수는 board를 변경하지 않는다(serialize는 읽기 전용).
 *              자기완결을 보장하려면 board.items[].src가 data URL이어야 한다(임베드는 호출측 책임).
 * @param opts.viewerScript 인라인할 뷰어 IIFE 번들 문자열(없으면 자리표시 주석 유지).
 * @param opts.title        문서 title(없으면 보드 제목 → 폴백 'RefBoard').
 * @returns 단일 HTML 문서 문자열.
 */
export function buildSelfContainedHtml(board: BoardState, opts?: BuildHtmlOptions): string {
  // title 결정: 명시 옵션 > 보드 제목 > 'RefBoard'.
  const rawTitle = opts?.title ?? board.board.title ?? ''
  const title = rawTitle.trim() || 'RefBoard'

  // 보드 데이터 직렬화(board.ts의 serialize가 단일 진실 — 포맷 일관성 유지).
  // </script> 조기 종료 방지를 위해 script-safe하게 escape한다.
  const dataJson = escapeJsonForScript(serialize(board))

  // 뷰어 번들: 있으면 <script>로 인라인, 없으면 자리표시 주석을 남긴다.
  // 인라인 시에도 '</script>' 조기 종료를 막기 위해 동일 escape를 적용한다
  // (IIFE 번들 안에 문자열 리터럴로 '</script>'가 들어갈 수 있음).
  const viewerBlock = opts?.viewerScript
    ? `<script>\n${escapeJsonForScript(opts.viewerScript)}\n</script>`
    : VIEWER_BUNDLE_PLACEHOLDER

  const canvasBg = board.board.canvas?.bg ?? '#1e1e1e'

  // 최소 부트 HTML. CSS는 인라인(외부 의존 0). #app은 뷰어 마운트 지점,
  // #refboard-loading은 뷰어가 부팅을 끝내면 숨기거나 제거한다(뷰어 책임).
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="RefBoard">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ${escapeHtml(canvasBg)}; }
  #app { position: fixed; inset: 0; width: 100%; height: 100%; }
  #refboard-loading {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #888; font: 14px system-ui, -apple-system, "Segoe UI", sans-serif; user-select: none;
  }
</style>
</head>
<body>
<div id="app"></div>
<div id="refboard-loading">불러오는 중…</div>
<script type="application/json" id="${BOARD_DATA_ELEMENT_ID}">${dataJson}</script>
${viewerBlock}
</body>
</html>`
}

/**
 * HTML 문자열을 파일로 다운로드한다(Blob + 임시 <a download> 클릭).
 * export-image.ts의 downloadBlob과 동일한 관용구지만, share 모듈을 자기완결로 두기 위해
 * (이미지 렌더 모듈에 결합하지 않도록) 여기서 자체 구현한다.
 * @param html      저장할 HTML 문서 문자열
 * @param filename  파일명(확장자 포함). 예: 'my-board.html'
 */
export function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // 일부 브라우저는 DOM에 붙어 있어야 click이 동작 → 붙였다 즉시 제거.
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 대용량 다운로드가 동기 revoke로 취소되지 않도록 다음 틱에 해제(bug-io P3).
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
