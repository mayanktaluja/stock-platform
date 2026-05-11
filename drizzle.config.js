// drizzle-kit config — generates SQL migrations from db/schema.js.
// Always uses the direct (unpooled) connection for DDL; pooled bouncer
// can't run schema-mutating statements.

import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.js",
  out: "./db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "",
  },
  verbose: false,
  strict: true,
});
