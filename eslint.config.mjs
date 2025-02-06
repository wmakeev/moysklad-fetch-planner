import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import nodePlugin from 'eslint-plugin-n'

export default tseslint.config(
  eslint.configs.recommended,
  nodePlugin.configs['flat/recommended-script'],
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs']
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'warn',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: 'it', package: 'node:test' },
            { from: 'package', name: 'test', package: 'node:test' },
            { from: 'package', name: 'skip', package: 'node:test' },
            { from: 'package', name: 'only', package: 'node:test' },
            {
              from: 'package',
              name: 'stringToUint8Array',
              package: 'uint8array-extras'
            }
          ]
        }
      ],
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',

      '@typescript-eslint/restrict-template-expressions': 'off'
    }
  },
  {
    ignores: ['build/', '__temp/', 'coverage/']
  }
)
