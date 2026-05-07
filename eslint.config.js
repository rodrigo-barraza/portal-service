import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import { createServiceEslintConfig } from "@rodrigo-barraza/utilities-library/eslint";

export default createServiceEslintConfig({ js, prettierConfig, globals });
