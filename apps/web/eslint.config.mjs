import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
void fileURLToPath(import.meta.url);

const coreWebVitals = require("eslint-config-next/core-web-vitals");
const typescript = require("eslint-config-next/typescript");

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "public/**",
      "tsconfig.tsbuildinfo",
      "tsconfig-test.tsbuildinfo",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    // eslint-plugin-react-hooks@7 (peer of eslint-config-next@16) ships
    // stricter `react-hooks/refs` + `react-hooks/set-state-in-effect`
    // rules. The codebase predates those checks; refactoring every
    // ref/effect call site is out of scope for the security upgrade
    // (GRE-82). The classic rules (`exhaustive-deps`, `rules-of-hooks`)
    // remain active via the recommended set.
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default config;
