import dotenv from "dotenv";

dotenv.config();

export const env = {
  OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
  RACSO_HARNESS_CONFIG_LOCATION: process.env.RACSO_HARNESS_CONFIG_LOCATION,
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
