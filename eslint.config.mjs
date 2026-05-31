/** @type {import('eslint').Linter.Config} */
module.exports = {
    files: ['*.js', 'src/**/*.js'],
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'commonjs',
        globals: {
            require: 'readonly',
            module: 'readonly',
            __dirname: 'readonly',
            process: 'readonly',
            Buffer: 'readonly',
            setTimeout: 'readonly',
            clearTimeout: 'readonly',
            Promise: 'readonly'
        }
    },
    rules: {
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        'no-undef': 'warn'
    }
};
