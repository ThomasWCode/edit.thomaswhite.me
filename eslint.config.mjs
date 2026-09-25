const sharedRules = {
  eqeqeq: "error",
  "no-redeclare": "error",
  "no-undef": "error",
  "no-unreachable": "error",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
};

const browserGlobals = {
  AbortController: "readonly",
  Blob: "readonly",
  crypto: "readonly",
  CustomEvent: "readonly",
  document: "readonly",
  fetch: "readonly",
  history: "readonly",
  HTMLElement: "readonly",
  Intl: "readonly",
  localStorage: "readonly",
  location: "readonly",
  navigator: "readonly",
  Node: "readonly",
  requestAnimationFrame: "readonly",
  Request: "readonly",
  Response: "readonly",
  sessionStorage: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  window: "readonly",
};

const nodeGlobals = {
  AbortSignal: "readonly",
  Buffer: "readonly",
  console: "readonly",
  crypto: "readonly",
  fetch: "readonly",
  process: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", "playwright-report/**", "test-results/**", "vendor/**", ".wrangler/**"],
  },
  {
    files: ["src/**/*.js", "dev/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: browserGlobals },
    rules: sharedRules,
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: nodeGlobals },
    rules: sharedRules,
  },
  {
    files: ["tests/e2e/**/*.mjs"],
    languageOptions: { globals: { ...nodeGlobals, document: "readonly", window: "readonly", location: "readonly" } },
  },
];
