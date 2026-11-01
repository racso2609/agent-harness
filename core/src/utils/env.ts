import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

// Root directory for all harness persisted state (config, sessions, ...).
export const HARNESS_DIR_NAME = ".racso-harness";

export const harnessHome = () =>
  path.join(process.env.HOME ?? process.cwd(), HARNESS_DIR_NAME);

// Directory holding the markdown agent definitions.
export const agentsHome = () =>
  env.RACSO_HARNESS_AGENTS_LOCATION ?? path.join(harnessHome(), "agents");

export const env = {
  OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
  RACSO_HARNESS_CONFIG_LOCATION: process.env.RACSO_HARNESS_CONFIG_LOCATION,
  RACSO_HARNESS_SESSIONS_LOCATION:
    process.env.RACSO_HARNESS_SESSIONS_LOCATION,
  RACSO_HARNESS_AGENTS_LOCATION: process.env.RACSO_HARNESS_AGENTS_LOCATION,
  LOG_LEVEL: process.env.LOG_LEVEL as
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent"
    | undefined,
  HOME: process.env.HOME,
} as const;

export type Env = typeof env;
