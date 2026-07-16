import tseslint from "typescript-eslint";
import tsparser from "@typescript-eslint/parser";

export default tseslint.config(
  {
    ignores: [
      "**/convex/_generated/",
      // Local components keep their own generated code, e.g. convex/<component>/_generated/
      "**/_generated/",
      "evals/**/grader.test.ts",
      "scripts/**",
      "guidelines/**",
      "runner/models/cursorSdkGenerate.mjs",
    ],
  },
  tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: true,
        allowDefaultProject: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "require-await": "off",
      "@typescript-eslint/require-await": "off",

      // Enforce proper async/await usage
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/promise-function-async": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],

      // Enforce proper function return types (warn only — models sometimes
      // extract DRY helpers without an explicit return type annotation and
      // that's acceptable code quality).
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
        },
      ],

      // prefer-const is a stylistic nit — not a correctness issue. Downgrade
      // to warning so models aren't penalised for using `let` on variables
      // they don't reassign.
      "prefer-const": "warn",

      // Prevent accidental any
      // no-unsafe-assignment and no-unsafe-return are disabled because v.any()
      // is a legitimate Convex pattern and requiring models to place
      // eslint-disable comments tests eslint fluency, not Convex knowledge.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "off",

      // Enforce proper error handling
      "no-throw-literal": "error",
    },
  },
);
