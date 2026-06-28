// ESLint flat config — RefBoard 코드 품질 굳히기로 점진 도입(2026-06-28).
// 방침: 포맷(세미콜론·따옴표·줄바꿈)은 Prettier에 위임하고, ESLint는 "버그성"만 본다.
//       기존 코드를 즉시 빨간 줄로 막지 않도록 일부는 warn으로 노출 후 차차 정리.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  // 검사 제외: 산출물·의존성·러스트·빌드 스크립트·정적 자산·설정 파일.
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'scripts/**', 'public/**', 'coverage/**', '*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // prettier는 반드시 마지막 — Prettier와 충돌하는 ESLint 포맷 규칙을 모두 끈다.
  prettier,
  {
    languageOptions: {
      // 브라우저(런타임) + Node(빌드/테스트) 전역 모두 허용.
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // any는 막기보다 노출(점진 제거 대상).
      '@typescript-eslint/no-explicit-any': 'warn',
      // a.addedAt! 같은 의도적 non-null 단언은 허용(타입 가드 직후 사용 등).
      '@typescript-eslint/no-non-null-assertion': 'off',
      // _ 접두 인자/변수는 "의도적 미사용"으로 간주해 통과.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
