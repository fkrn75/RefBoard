# RefBoard Phase 6 — 품질·마감 감사 (2026-06-18)

팀 오케스트라 4팀원 병렬 감사 → team-lead 단일 writer 수정. 발견 **59건**(P1 14 / P2 24 / P3 21).
이 중 **24건 수정 적용**, 나머지는 사양 판단·런타임 검증 필요·저우선으로 보류(아래 사유 표기).

검증: `tsc --noEmit` exit 0 · `vite build` exit 0 · 뷰어/편집기 런타임(콘솔 에러 0) · 접근성 키보드 플로우 E2E.

범례: ✅ 수정 적용 · ⏸ 보류(사유) · 🔎 런타임 확인 권장

---

## 1. bug-core — 코어 편집 (P1 3 / P2 4 / P3 4)

| # | 등급 | 항목 | 위치 | 상태 |
|---|---|---|---|---|
| 1 | P1 | 크롭 후 기즈모가 원본(natural) 크기 기준 → 외곽선과 어긋남·스케일 피벗 튐 | main.ts:215/365/417 | ✅ `croppedSize(im.crop, im.natural)`로 3개소 통일 |
| 2 | P1 | undo/redo가 카메라까지 복원 → 화면 점프 | main.ts restore/doUndo/doRedo | ✅ `restore(state,{keepCamera})` 추가, undo/redo는 현재 카메라 유지 |
| 3 | P1 | 회전 이미지 크롭 시 화면축 드래그 ≠ 픽셀축 크롭 | main.ts enterCropMode | ✅ 회전≠0이면 토스트로 차단(변형 리셋 후 가능) |
| 4 | P2 | 그룹 선택은 항상 2+ → 기즈모(단일 전용) 안 떠 회전/스케일 불가 | main.ts refreshGizmo | ⏸ 사양(그룹 통짼 변형은 별도 기능 — 후속) |
| 5 | P2 | 다중선택 이동 스냅이 대표(첫) 아이템 기준 | main.ts onPointerMove | ⏸ 사양(묶음 AABB 스냅은 후속) |
| 6 | P2 | distribute/align이 회전 이미지에서 AABB 기준 → 시각 불균등 | align.ts | ⏸ 모듈 주석에 명시된 의도적 단순화 |
| 7 | P2 | resetTransform이 중심 고정이라 큰 변형 리셋 시 위치 점프 | main.ts resetTransform | ⏸ 의도된 동작(피벗 옵션은 후속) |
| 8 | P3 | packAll `find(...)!` 비널 단언 → desync 시 크래시 | main.ts:568 | ✅ flatMap + 가드로 단언 제거 |
| 9 | P3 | duplicate/place의 z가 normalizeZ 미경유로 누적 | main.ts | ⏸ 무해(비연속일 뿐 동작 정상) |
| 10 | P3 | minimap letterbox 밖 클릭도 점프 | minimap.ts | ⏸ 저우선(드문 케이스) |
| 11 | P3 | 휠 줌 클램프 경계에서 커서 고정점 미세 어긋남 | main.ts:294 | ⏸ 무해(경계에서만, 무시 가능) |

## 2. bug-io — 영속·공유·내보내기·단축키 (P1 3 / P2 9 / P3 7)

| # | 등급 | 항목 | 위치 | 상태 |
|---|---|---|---|---|
| 1 | P1 | 원격 이미지 fetch 실패를 조용히 링크 유지(임베드 누락·영구 유실) | refb.ts:175 | ⏸ 호출측 signature 변경 필요 → 후속(현재 catch로 board 보존은 됨) |
| 2 | P1 | downscale 완전 실패 시 0×0 자연크기로 배치 | downscale.ts:226, main.ts importFiles | ✅ 폴백에서 `<img>` 재측정 + main.ts 0×0 배치 거부(2중 방어) |
| 3 | P1 | pickRefbFile focus 폴백이 느린 디스크에서 선택을 취소로 오판 | io.ts:54 | ✅ `settled` 플래그 + `oncancel` 이벤트 + 폴백 500ms |
| 4 | P2 | 손상 board.json(items 누락)이면 `for…of`에서 TypeError 크래시 | refb.ts:279 | ✅ `Array.isArray(state.items)` 가드 |
| 5 | P2 | non-base64 data URL(SVG 텍스트 등) → decodeDataUrl throw로 저장 전체 실패 | refb.ts:174 | ✅ data URL 분기 try/catch(링크 유지 폴백) |
| 6 | P2 | keymap 기호/숫자 키가 shifted `e.key`라 향후 줌 단축키 충돌 위험 | keymap.ts | ⏸ 현재 dead alias(실해 없음) — 줌 단축키 도입 시 code 기반 정규화 |
| 7 | P2 | `Shift+기호` 액션 잠재 미스매치(Bracket 외) | keymap.ts | ⏸ 현 카탈로그 한정 안전(#6과 동일 근본) |
| 8 | P2 | LocalShareAdapter.upload 쿼터 초과 throw 누수 | share-adapter.ts:78 | ✅ try/catch → 친절한 메시지 |
| 9 | P2 | genId 8자리 슬라이스 충돌(자산 경로·공유 id 덮어쓰기) | board.ts:69 | ✅ 12자리로 상향 |
| 10 | P2 | autosave openDb onblocked·멀티탭 경합 | autosave.ts:236 | ⏸ 연결 캐싱 리팩터 위험 → 후속 |
| 11 | P2 | export 음수 frame 좌표 추출 정확성 | export-image.ts:79 | 🔎 추정 — 런타임 확인 권장(코드 변경 불요 가능) |
| 12 | P3 | recent ts 미검증(NaN/미래값 정렬 왜곡) | recent.ts | ✅ `Number.isFinite(o.ts)` 검사 추가 |
| 13 | P3 | revokeObjectURL 즉시 호출 → 대용량 다운로드 취소 가능 | export-image.ts:261, share-export.ts:146 | ✅ `setTimeout(…,1000)`으로 지연 해제(양쪽) |
| 14 | P3 | tauri-bridge 네이티브 함수 isDesktop 가드 없음 | tauri-bridge.ts | ⏸ 호출측 가드로 충분(저우선) |
| 15 | P3 | share-export escape 함수명 오해 소지(버그 아님) | share-export.ts:96 | ⏸ 동작 정상 |
| 16 | P3 | theme glass rgba 오버라이드 시 캔버스 폴백 불일치 | theme.ts | ⏸ 엣지(사용자 rgba 오버라이드) |
| 17 | P3 | command-palette 검색이 label/group만(id 제외) | command-palette.ts | ✅ hay에 `a.id` 추가 |

## 3. perf — 성능 프로파일링 (P1 3 / P2 4 / P3 4)

| # | 등급 | 항목 | 위치 | 상태 |
|---|---|---|---|---|
| 1 | P1 | applyCam이 팬/줌 매 이벤트마다 6중 O(n) 작업을 스로틀 없이 실행 | main.ts:230 | ✅ rAF 코얼레싱(즉시=카메라, 무거운 작업=프레임당 1회) |
| 2 | P1 | updateMinimap→contentBounds가 숨김 상태에서도 매번 O(n) 계산 | main.ts:200 | ✅ `minimap.isVisible()`면 contentBounds 자체 생략(기본=숨김) |
| 3 | P1 | virt.update가 매 카메라 이벤트마다 전 아이템 순회+할당 | main.ts:238 | ✅ #1 코얼레싱으로 프레임당 1회로 완화 |
| 4 | P2 | 이미지 가져오기 디코드+다운스케일+배치 전부 순차 | main.ts:1136 | ⏸ 후속(동시성 제한 병렬·downscale Worker화) |
| 5 | P2 | scene.rebuild가 복원/undo/redo 시 n장 순차 디코드 | scene.ts:177 | ✅ `Promise.all` 병렬 디코드(z는 zIndex가 보장) |
| 6 | P2 | packImages 동기 O(~25·n²) 대량 프리즈 | pack.ts:146 | ⏸ 후속(이진탐색 축소·Worker화) |
| 7 | P2 | 텍스처 재업로드 thrash(큰 단일 아이템 줌) | virtualize.ts:79 | ⏸ 일반 케이스 영향 적음 — 실측 시 대응 |
| 8 | P3 | updateStatus 매 프레임 DOM 갱신 | main.ts:237 | ✅ #1 코얼레싱에 포함(프레임당 1회) |
| 9 | P3 | drawGrid 가시영역 라인 전량 재생성 | scene.ts:240 | ⏸ 부담 작음(grid.ts 라인 상한 확인 권장) |
| 10 | P3 | board.serialize 전체 직렬화(autosave 5분) | board.ts:59 | ⏸ 빈도 낮아 최하위 |
| 11 | P3 | GIF 매번 fetch+fromBuffer(의도적 캐시 회피) | scene.ts:112 | ⏸ 인스턴스 공유 충돌 회피 위한 의도 |

## 4. a11y — 웹 뷰어 접근성 (P1 5 / P2 7 / P3 6)

| # | 등급 | 항목 | 위치 | 상태 |
|---|---|---|---|---|
| 1 | P1 | PWA start_url·SW 폴백이 편집앱(index)을 가리킴 | manifest·sw.js | ✅ start_url=/viewer.html, SW 폴백 viewer.html 우선, precache 추가, CACHE v2 |
| 2 | P1 | 라이트박스를 키보드만으로 열 수 없음 | viewer/main.ts | ✅ sr-only 이미지 목록(포커스·활성화 가능) 제공 |
| 3 | P1 | 라이트박스 포커스 트랩·복원·초기 포커스 없음 | lightbox.ts | ✅ 열기 시 닫기버튼 포커스·Tab 트랩·Esc 닫기 시 트리거 복원 |
| 4 | P1 | 이미지 로드 실패 무처리 + alt='' | lightbox.ts | ✅ 항목별 의미 있는 alt + onerror 안내 |
| 5 | P1 | viewport user-scalable=no(WCAG 1.4.4 위반) | viewer.html, share-export.ts | ✅ user-scalable/maximum-scale 제거(핀치 줌 허용) |
| 6 | P2 | 보조 텍스트 대비 AA 미달(dim #777/#888) | theme.ts | ✅ dark #9a9a9a / light #6a6a6a로 상향 |
| 7 | P2 | board-meta 가짜 heading(role=heading) | board-meta.ts | ✅ 네이티브 `<h1>` |
| 8 | P2 | 캔버스에 대체 텍스트·라벨 없음 | viewer/main.ts | ✅ sr-only 이미지 목록이 비텍스트 대체 제공(#2와 동일 수정) |
| 9 | P2 | prefers-reduced-motion 미존중 | lightbox.ts | ✅ 줌 트랜지션 조건부 비활성 |
| 10 | P2 | 닫기 버튼 40px(<44 권장) | lightbox.ts:164 | ✅ 44×44 |
| 11 | P2 | 캡션 aria 연동·전환 안내 부족 | lightbox.ts | ⏸ 부분 개선(alt 연동), dialog aria-labelledby는 후속 |
| 12 | P2 | 라이트박스 열림 중 배경 resize→fitAll 흔들림 | viewer/main.ts | 🔎 추정 — 저우선 |
| 13 | P3 | lazyload.ts 미배선(dead code) | viewer/lazyload.ts | ⏸ 뷰어 가상화 배선은 후속(현재 rebuild 일괄 로드) |
| 14 | P3 | hitTest AABB라 회전 이미지 오클릭 | viewer/main.ts:72 | ⏸ 정확도(P3) — OBB는 후속 |
| 15 | P3 | 임베드 손상 시 진단 로그 없음 | viewer/main.ts:133 | ⏸ 디버깅성(저우선) |
| 16 | P3 | "보드 없음" role/aria-live 없음 | viewer/main.ts:151 | ✅ `role="status"` 부여 |
| 17 | P3 | 캡션 pointer-events:none로 텍스트 선택 불가 | lightbox.ts:203 | ⏸ 닫기 동작 트레이드오프(유지) |
| 18 | P3 | sw.js viewer.html precache 누락 | sw.js | ✅ SHELL_ASSETS에 추가(#1과 함께) |

---

## 수정 요약 (총 24건 적용)

- **코어 편집(4)**: 크롭+기즈모 통일, undo 카메라 유지, 회전 크롭 차단, packAll 단언 제거
- **영속/공유(8)**: refb items 가드·non-base64 data URL, downscale 0×0 방어, pickRefbFile 취소 정확화, share 쿼터, genId 엔트로피, recent ts, palette 검색, revoke 지연
- **성능(4)**: applyCam rAF 코얼레싱, minimap 숨김 시 스킵, scene.rebuild 병렬, updateStatus 코얼레싱
- **접근성(8)**: PWA 라우팅+SW, 키보드 진입(sr-only 목록), 포커스 트랩/복원, 이미지 alt+onerror, viewport, 대비 AA, h1, reduced-motion, 44px, role=status

## 후속(보류) 핵심

- 그룹 통짼 변형, 다중선택 묶음 스냅(사양 결정 필요)
- 원격 이미지 fetch 실패 사용자 통지(packRefb signature 변경)
- 가져오기/pack/downscale Worker화·동시성 제한(대량 성능 추가 개선)
- autosave 연결 캐싱, 뷰어 lazyload 배선, hitTest OBB
- 🔎 런타임 확인 권장: export 음수 frame(bug-io #11)
