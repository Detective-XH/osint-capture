// ESLint 10 flat config (.mjs because package.json is CommonJS by default).
//
// Phase A: base `recommended` (non-type-checked) so lint runs on the mixed JS/TS
// tree without a full type graph. Phase C upgrade — the `go vet` equivalent — swap
// `tseslint.configs.recommended` → `tseslint.configs.recommendedTypeChecked` and
// uncomment the parserOptions below to unlock type-aware rules (no-floating-promises,
// no-misused-promises, no-unsafe-*).
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'temp/**',
      'node_modules/**',
      'src/lib/**', // ClearURLs LGPL data, not our code
      'src/icons/**',
      'build.js', // Node build script (CommonJS)
      'scripts/**', // Node helper scripts (CommonJS, require() is correct)
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Phase C: parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { chrome: 'readonly' },
    },
    rules: {
      // gocyclo analogue. 20 (not the stricter default 15): this codebase has inherently
      // branchy dispatch/UI/init functions (date-format dispatch, field builders, popup init
      // wiring) where mechanical splitting adds indirection without reducing real complexity.
      // Functions still over 20 carry a justified inline disable explaining the intrinsic cost.
      complexity: ['warn', 20],
      // Migration stance: `any` from the JS→TS overlay is visible debt, not a hard
      // failure — tighten in the follow-up (typed ClearURLs provider + storage shapes).
      '@typescript-eslint/no-explicit-any': 'warn',
      // Respect the codebase's _-prefix convention for intentionally-unused bindings.
      // args:'none' mirrors Go (unused params/receivers are allowed; only unused
      // locals/imports are flagged) — fits chrome's callback signatures you can't
      // shrink, and avoids renaming params (which would alter the byte-identical bundle).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier, // must stay LAST so it disables stylistic rules Prettier owns
);
