import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  {
    ignores: [
      ".vercel",
      "dist",
      "public/litert",
      "public/mediapipe",
    ],
  },
  {
    files: ["**/*.{js,jsx}"],
    plugins: {
      ...reactHooks.configs.flat["recommended-latest"].plugins,
      ...reactRefresh.configs.vite.plugins,
    },
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      parserOptions: { ecmaVersion: "latest", ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.flat["recommended-latest"].rules,
      ...reactRefresh.configs.vite.rules,
    },
  },
];
