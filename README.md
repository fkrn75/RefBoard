# RefBoard

> PureRef 호환 레퍼런스 이미지 보드 + 웹 공유

무한 캔버스에 레퍼런스 이미지를 모아 자유롭게 배치·정리하는 데스크탑 도구입니다. [PureRef](https://www.pureref.com/)의 핵심 기능을 구현하고, 추가로 **보드를 웹 링크로 공유해 다른 PC·모바일에서도 열람**합니다.

## 현재 상태 (MVP 완료 · 기능 확장 중)

- ✅ 무한 캔버스 (휠 줌 · 우클릭/휠클릭 팬 · 더블클릭 fit)
- ✅ 이미지 가져오기 (드래그드롭 · 클립보드 붙여넣기 · 파일 열기)
- ✅ 선택 (단일 · Shift 다중 · 러버밴드) + 외곽선 표시 · 이전/다음 항목 순회
- ✅ 드래그 이동 (다중 동시) · 스케일 · 회전 · 크롭
- ✅ 자동 패킹 · 캔버스 최적화(정돈) · 삭제/복제 · z순서(앞/뒤)
- ✅ 정렬 (좌/우/상/하 · 가로/세로 중앙) · 균등 분배 (수평/수직)
- ✅ 크기 통일 (폭/높이/배율/면적) · 기준별 격자 정렬 (이름/추가순/레이어순/무작위, 재실행 시 역순 토글)
- ✅ 내보내기 — 씬 전체 / 선택 / 개별(아이템마다 1장씩) · PNG·JPG·BMP
- ✅ 색상 스포이드 (캔버스 색 추출 → 클립보드 복사)
- ✅ 저장/열기 (`.refb` ZIP 포맷) · 자동저장 · 최근 파일 열기
- ✅ Tauri 2 데스크탑 셸 · 웹 공유 (Supabase 업로드 → 링크 → 모바일 읽기 전용 뷰어)
- ✅ 텍스트 노트 (색·크기·글꼴) · 펜/도형 드로잉 · 이미지 댓글
- ✅ 커맨드 팔레트 (`Ctrl+Shift+P`) · 재바인딩 가능한 단축키
- ⬜ URL 스크랩 · 누락 이미지 Relink · 미니맵/성능모드 확장 등 — 진행 중

상세 진행은 [체크리스트](체크리스트.md), 전체 기능 명세는 [기능명세서](기능명세서.md)를 참고하세요.

## 단축키

모든 단축키는 설정 패널(`Ctrl+,`)에서 재바인딩할 수 있습니다. 표는 기본값이며, 단축키 정의의 단일 출처(SSOT)는 `src/core/keymap.ts`(+ 도구 콤보는 `src/main.ts`)입니다. 콤보가 비어 있는 동작은 **커맨드 팔레트(`Ctrl+Shift+P`)**나 툴바로 실행합니다. (`Ctrl`은 macOS에서 `Cmd`로 동작)

### 보기

| 동작 | 단축키 |
| --- | --- |
| 전체 보기 | `Ctrl+Space` |
| 선택 항목으로 포커스 | `Space` |
| 줌 100% | `Ctrl+0` |
| 미니맵 토글 | `M` |
| 스냅 토글 | `N` |
| 그리드 토글 | `G` |
| 캔버스 최적화(정돈) | `Ctrl+Alt+P` |
| 이전 항목 | `←` |
| 다음 항목 | `→` |

### 편집

| 동작 | 단축키 |
| --- | --- |
| 전체 선택 | `Ctrl+A` |
| 선택 해제 / 크롭 종료 | `Esc` |
| 삭제 | `Delete` (또는 `Backspace`) |
| 복제 | `Ctrl+D` |
| 실행취소 | `Ctrl+Z` |
| 다시실행 | `Ctrl+Shift+Z` (또는 `Ctrl+Y`) |
| 잠금 토글 | `Alt+L` |

### 정렬·배치

| 동작 | 단축키 |
| --- | --- |
| 자동 배치(Pack) | `Ctrl+P` |
| 그룹 / 그룹 해제 | `Ctrl+G` / `Ctrl+Shift+G` |
| 왼쪽 / 오른쪽 정렬 | `Ctrl+←` / `Ctrl+→` |
| 위 / 아래 정렬 | `Ctrl+↑` / `Ctrl+↓` |
| 가로 / 세로 중앙 정렬 | 커맨드 팔레트·툴바 |
| 수평 / 수직 균등 분배 | `Ctrl+Shift+←` / `Ctrl+Shift+↑` |
| 폭 통일 / 높이 통일 | `Ctrl+Alt+↑` / `Ctrl+Alt+→` |
| 배율 통일 / 면적 통일 | `Ctrl+Alt+←` / `Ctrl+Alt+↓` |
| 격자: 이름순 / 추가순 | `Ctrl+Alt+N` / `Ctrl+Alt+A` |
| 격자: 레이어순 / 무작위 | `Ctrl+Alt+O` / `Ctrl+Alt+R` |
| 앞으로 / 맨 앞으로 | `]` / `Shift+]` |
| 뒤로 / 맨 뒤로 | `[` / `Shift+[` |

> 격자 정렬은 같은 키를 다시 누르면 오름/내림차순이 토글됩니다.

### 변형

| 동작 | 단축키 |
| --- | --- |
| 자르기(Crop) 시작 | `C` |
| 크롭 초기화 | `Ctrl+Shift+C` |
| 변형 초기화 | `Ctrl+Shift+T` |
| 좌우 / 상하 반전 | `Alt+Shift+H` / `Alt+Shift+V` |

### 도구

| 동작 | 단축키 |
| --- | --- |
| 선택 도구 | `V` |
| 텍스트 도구 | `T` |
| 펜 도구 | `P` |
| 직선 도구 | `L` |
| 사각형 도구 | `R` |
| 타원 도구 | `O` |
| 화살표 도구 | `A` |
| 드로잉 지우개 | `E` |
| 스포이드(색 추출) | `S` |
| 이미지 댓글 | `Alt+C` |

### 파일

| 동작 | 단축키 |
| --- | --- |
| 이미지 가져오기 | `Ctrl+I` |
| 저장 | `Ctrl+S` |
| 열기 | `Ctrl+O` |
| 최근 파일 열기 | `Ctrl+Alt+L` |
| 씬 내보내기(PNG) | `Ctrl+E` |
| 선택 내보내기(PNG) | `Ctrl+Shift+E` |
| 개별 내보내기 · 전체 | `Ctrl+Alt+I` |
| 개별 내보내기 · 선택 | 커맨드 팔레트 |

> 내보내기 포맷은 PNG·JPG·BMP를 지원합니다 (PNG=투명 보존, JPG=손실 압축, BMP=무압축).

### 창 (데스크탑 전용)

| 동작 | 단축키 |
| --- | --- |
| 항상 위 / 항상 아래 | `Ctrl+Shift+A` / `Ctrl+Shift+B` |
| 타이틀바 숨김/표시 | `Ctrl+Shift+D` |
| 마우스 통과(클릭스루) | `Ctrl+Alt+T` |
| 창 불투명도 순환 | `Ctrl+Shift+O` |
| 캔버스 잠금 | `Ctrl+Shift+L` |

### 앱

| 동작 | 단축키 |
| --- | --- |
| 커맨드 팔레트 | `Ctrl+Shift+P` |
| 설정 | `Ctrl+,` |
| 웹 뷰어 링크 공유 | `Ctrl+Shift+S` |

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
