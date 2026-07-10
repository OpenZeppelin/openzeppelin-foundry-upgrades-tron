module.exports = {
  extends: 'solhint:recommended',
  rules: {
    'compiler-version': ['error', '^0.8.22'],
    'func-visibility': ['error', { ignoreConstructors: true }],
  },
};
