// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'drizzle/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // NOTE: @typescript-eslint/consistent-type-imports is deliberately NOT
      // enabled. NestJS DI resolves constructor parameters through
      // emitDecoratorMetadata; `import type` is erased at compile time, which
      // turns the emitted metadata into `Object` and silently breaks injection.
    },
  },
);
