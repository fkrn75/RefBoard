# RefBoard

> PureRef 호환 레퍼런스 이미지 보드 + 웹 공유

무한 캔버스에 레퍼런스 이미지를 모아 자유롭게 배치·정리하는 데스크탑 도구입니다. [PureRef](https://www.pureref.com/)의 핵심 기능을 구현하고, 추가로 **보드를 웹 링크로 공유해 다른 PC·모바일에서도 열람**합니다.

## 현재 상태 (MVP 완료 · 기능 확장 중)

- ✅ 무한 캔버스 (휠 줌 · 우클릭/휠클릭 팬 · 더블클릭 fit)
- ✅ 이미지 가져오기 (드래그드롭 · 클립보드 붙여넣기 · 파일 열기)
- ✅ 선택 (단일 · Shift 다중 · 러버밴드) + 외곽선 표시
- ✅ 드래그 이동 (다중 동시) · 스케일 · 회전 · 크롭
- ✅ 자동 패킹 · 삭제/복제 · z순서(앞/뒤) · 정렬
- ✅ 저장/열기 (`.refb` ZIP 포맷) · 자동저장 · 최근 파일
- ✅ Tauri 2 데스크탑 셸 · 웹 공유 (Supabase 업로드 → 링크 → 모바일 읽기 전용 뷰어)
- ✅ 텍스트 노트 · 펜/도형 드로잉 · 이미지 댓글
- ⬜ URL 스크랩 · 누락 이미지 Relink · 미니맵/성능모드 확장 등 — 진행 중

상세 진행은 [체크리스트](체크리스트.md), 전체 기능 명세는 [기능명세서](기능명세서.md)를 참고하세요.

## 기술 스택

- **데스크탑**: Tauri 2 + Vite + TypeScript
- **렌더링**: PixiJS (WebGL) — 무한 캔버스 · 수백 장 이미지 대응
- **웹 공유**: Supabase(스토리지·인증·RLS) + 읽기 전용 웹 뷰어(`viewer.html`)

핵심 설계: 렌더링을 웹 기술로 통일해 **데스크탑 앱과 웹 뷰어가 같은 코어(`src/core/`)를 공유**합니다.

## 개발

```bash
cd app
npm install
npm run dev        # http://localhost:1420
```

## 구조

```
app/
  index.html         데스크탑/웹 에디터 진입점
  viewer.html        공유 보드 읽기 전용 뷰어 진입점
  public/
    sw.js            뷰어 PWA 서비스 워커(오프라인 캐시)
  src/
    main.ts          에디터 입력 배선(선택/이동/줌/팬/가져오기/단축키)
    core/            데스크탑·뷰어 공유 코어 (~30개 모듈)
      board.ts       보드 상태 모델(SSOT) · 직렬화
      scene.ts       PixiJS 렌더러 · 카메라 · 노드(이미지/노트/드로잉)
      selection.ts   선택 상태 관리
      gizmo.ts       스케일/회전 핸들 · 히트 테스트
      pack.ts        자동 패킹 배치
      crop.ts        크롭 · zorder.ts z순서 · align.ts 정렬 · grid.ts 격자
      snap.ts        스냅(이웃/격자) · group.ts 그룹화
      history.ts     Undo/Redo · autosave.ts 자동저장 · recent.ts 최근 파일
      refb.ts        .refb(ZIP) 저장/열기 · io.ts 파일 입출력
      keymap.ts      단축키 맵 · command-palette.ts 커맨드 팔레트
      style-control.ts / opacity-control.ts / toolbar.ts / settings-panel.ts  UI
      minimap.ts / virtualize.ts / downscale.ts / srcset.ts  성능·대량 이미지
      share-export.ts / supabase-share.ts / supabase.ts / share-*.ts  공유
      tauri-bridge.ts  Tauri 데스크탑 연동 · theme.ts 테마
    viewer/          공유 뷰어 전용
      main.ts        뷰어 부트스트랩 · touch.ts 핀치/탭 · lightbox.ts 라이트박스
      lazyload.ts / board-meta.ts / pwa.ts
  src-tauri/         Tauri 2 데스크탑 셸(Rust) · tauri.conf.json
기능명세서.md          PureRef 조사 + 기능 명세(기획서)
체크리스트.md          개발 진행 단일 출처(SSOT)
docs/                설계 문서 · 감사 리포트
```

## 라이선스

미정 (개발 중)
