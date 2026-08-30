// Public deployment configuration. The Supabase URL and publishable key are
// safe to ship to browsers when Row Level Security from supabase/schema.sql is
// enabled. Never put a service-role key or a password in this file.

const deployedConfig = {
  url: "https://ejxxfkrmboawioqwrezg.supabase.co",
  anonKey: "sb_publishable_o-pktbB1y6--MJWcDntrdA_lzIEP5BZ",
  adminEmail: "admin@pickleball-planner.app",
  stateId: "primary",
};

const runtimeConfig = globalThis.__PICKLEBALL_SUPABASE_CONFIG__;
export const SUPABASE_CONFIG = Object.freeze(
  runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig : deployedConfig,
);