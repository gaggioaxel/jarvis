// Valori dell'istanza presi dalle variabili del Worker (wrangler.jsonc, generato da scripts/genera.py).
// configure() si chiama all'inizio di ogni richiesta MCP e di ogni giro degli avvisi.
import type { Env } from "./firestore";

export const CFG = { owner: "Utente", url: "", zone: "Europe/Rome" };

export function configure(env: Env) {
  CFG.owner = env.OWNER_NAME || "Utente";
  CFG.url = (env.BACHECA_URL || `https://${env.FIREBASE_PROJECT}.web.app`).replace(/\/$/, "");
  CFG.zone = env.TIMEZONE || "Europe/Rome";
}

/** Le mail ammesse, da ALLOWED_EMAIL separate da virgole. */
export function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}
