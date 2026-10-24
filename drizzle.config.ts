import { defineConfig } from "drizzle-kit";
import { validateDatabaseUrl } from "./lib/config";

/** Operator tooling only; application startup never invokes schema migrations. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/migration-schema.ts",
  out: "./migrations",
  dbCredentials: { url: validateDatabaseUrl(process.env.DATABASE_URL) },
  strict: true,
  verbose: false,
  breakpoints: true,
});
