import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import tsparser from "@typescript-eslint/parser";

export default tseslint.config(
  { ignores: ["dist", "**/convex"] },
  tseslint.configs.recommendedTypeChecked,
  {
    extends: [js.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      globals: globals.browser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Allow explicit `any`s
      "@typescript-eslint/no-explicit-any": "off",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],

      // TypeScript already catches undefined references (including globals from
      // @types/react), so no-undef causes false positives in TS projects.
      "no-undef": "off",

      // Consistent with eslint.config.mjs - unsafe-return fires as a cascade
      // when types are missing (e.g. @types/react not installed), making the
      // eslint step fail on top of an already-failing tsc step.
      "@typescript-eslint/no-unsafe-return": "off",

      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
);
