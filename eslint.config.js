import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['.output', '.wxt', 'node_modules', 'wasm/target', 'public/wasm', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off'
    },
  },
  { files: ['**/*.tsx'], rules: { '@typescript-eslint/no-misused-promises': 'off' } },
  { files: ['tests/**/*.ts', 'browser-tests/**/*.ts'], rules: { '@typescript-eslint/require-await': 'off' } },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
);
