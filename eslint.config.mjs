import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [".my-agent/**", ".next/**", "node_modules/**", "dist/**", "out/**"],
  },
  ...nextVitals,
];

export default eslintConfig;
