// Solo per le prove locali (npx wrangler dev src/dev.ts): MCP senza OAuth. Mai pubblicato.
import { Env } from "./firestore";
import { mcpFetch } from "./mcp";

export default {
  fetch(request: Request, env: Env) {
    const host = new URL(request.url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return new Response("solo locale", { status: 403 });
    return mcpFetch(request, env);
  },
};
