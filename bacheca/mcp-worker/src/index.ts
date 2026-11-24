// Server MCP remoto della bacheca di Jarvis, per i connettori di claude.ai.
//
// Accesso: OAuth gestito da @cloudflare/workers-oauth-provider. Il consenso si dà su questo Worker,
// poi si entra con Google sulla pagina mcp-login.html della bacheca (lo stesso Firebase Auth
// della bacheca), che torna qui con l'ID token di Firebase. Il Worker lo verifica e accetta solo le mail di ALLOWED_EMAIL.
import OAuthProvider, { type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Env } from "./firestore";
import { mcpFetch } from "./mcp";
import { runAlerts } from "./avvisi";
import { allowedEmails } from "./config";

const FIREBASE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string, headers?: Headers, status = 200): Response {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) h.set(k, v);
  return new Response(`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1f1e1c;--muted:#6b6862;--card:#fff;--line:#e3e0da;--accent:#1e64e6}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--fg:#ecebe8;--muted:#a19d96;--card:#262523;--line:#3a3835}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:420px;width:100%;box-sizing:border-box}
h1{font-size:20px;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}code{font-size:14px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font:inherit;padding:10px 14px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.warn{color:#c2410c}
</style></head><body><main>${body}</main></body></html>`, { status, headers: h });
}

function failure(message: string, status = 400): Response {
  return page("Accesso non riuscito", `<h1>Accesso non riuscito</h1><p>${esc(message)}</p>`, undefined, status);
}

async function consentPage(env: Env, auth: AuthRequest): Promise<Response> {
  const info = await env.OAUTH_PROVIDER.describeConsent(auth);
  const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(auth);
  const domain = info.clientDomain ? ` <span class="muted">(${esc(info.clientDomain)})</span>` : "";
  const loopback = info.redirectIsLoopback
    ? `<p class="warn">Il collegamento torna a un programma su questo computer: qualsiasi processo locale potrebbe riceverlo.</p>` : "";
  return page("Bacheca di Jarvis", `
<h1>Collegare la bacheca?</h1>
<p><strong>${esc(info.clientName)}</strong>${domain} chiede di leggere e modificare la bacheca di Jarvis.</p>
<p class="muted">L'accesso torna a <code>${esc(info.redirectHost)}</code>.</p>${loopback}
<p class="muted">Dopo il consenso entri con Google su ${esc(new URL(env.LOGIN_PAGE).host)}.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button name="decisione" value="no">Annulla</button>
<button class="primary" name="decisione" value="ok">Continua con Google</button></div>
</form>`, headers);
}

function redirect(location: string, headers: Headers): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: h });
}

async function verifyIdToken(env: Env, token: string): Promise<string> {
  const { payload } = await jwtVerify(token, FIREBASE_KEYS, {
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT}`,
    audience: env.FIREBASE_PROJECT,
    algorithms: ["RS256"],
  });
  const email = String(payload.email || "").toLowerCase();
  if (payload.email_verified !== true || !allowedEmails(env).includes(email)) {
    throw new Error(`L'account ${email || "senza mail"} non può usare la bacheca.`);
  }
  return email;
}

const CALLBACK_JS = `// Prende l'ID token dal frammento (che non arriva mai al server nei log) e lo rimanda qui in POST.
const token = new URLSearchParams(location.hash.slice(1)).get("id_token");
history.replaceState(null, "", location.pathname + location.search);
if (token) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = location.pathname + location.search;
  const input = document.createElement("input");
  input.type = "hidden"; input.name = "id_token"; input.value = token;
  form.append(input);
  document.body.append(form);
  form.submit();
} else {
  document.querySelector("main").innerHTML = "<h1>Accesso non riuscito</h1><p>Manca il token di Google: riprova dal connettore.</p>";
}
`;

const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        return await consentPage(env, await env.OAUTH_PROVIDER.parseAuthRequest(request));
      }

      if (url.pathname === "/authorize" && request.method === "POST") {
        const form = await request.formData();
        const handle = String(form.get("handle") || "");
        if (form.get("decisione") !== "ok") {
          const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
          return redirect(denied.redirectTo, denied.headers);
        }
        const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
        const upstream = await env.OAUTH_PROVIDER.beginUpstream(approved.request, { headers: new Headers(approved.headers) });
        const login = new URL(env.LOGIN_PAGE);
        login.searchParams.set("state", upstream.state);
        return redirect(login.toString(), upstream.headers);
      }

      if (url.pathname === "/callback" && request.method === "GET") {
        return page("Bacheca di Jarvis", `<h1>Accesso in corso…</h1><p class="muted">Un attimo.</p><script src="/callback.js"></script>`);
      }

      if (url.pathname === "/callback.js") {
        return new Response(CALLBACK_JS, {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/callback" && request.method === "POST") {
        const form = await request.formData();
        let email: string;
        try {
          email = await verifyIdToken(env, String(form.get("id_token") || ""));
        } catch (error) {
          return failure((error as Error).message.startsWith("L'account") ? (error as Error).message : "Token di Google non valido.", 403);
        }
        const resumed = await env.OAUTH_PROVIDER.finishUpstream(request);
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: resumed.request,
          userId: encodeURIComponent(email),
          metadata: { email },
          scope: resumed.request.scope,
          props: { email },
        });
        return redirect(redirectTo, resumed.headers);
      }

      if (url.pathname === "/") {
        return page("Bacheca di Jarvis", `<h1>Bacheca di Jarvis</h1><p>Server MCP. In claude.ai aggiungi un connettore personalizzato con l'indirizzo <code>${esc(url.origin)}/mcp</code>.</p>`);
      }
      return new Response("Non trovato", { status: 404 });
    } catch (error) {
      console.error(error);
      return failure((error as Error).message || "Errore inatteso.");
    }
  },
};

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: { email?: string } }): Promise<Response> {
    // Il token è già stato verificato dal provider; si ricontrolla comunque la mail del grant.
    if (!allowedEmails(env).includes(ctx.props?.email?.toLowerCase() || "")) {
      return new Response("Non autorizzato", { status: 403 });
    }
    return mcpFetch(request, env);
  },
};

// La risorsa RFC 9728 è l'indirizzo /mcp di questo Worker: si ricava dall'origine della richiesta
// (workers.dev in produzione, localhost nelle prove), così non va scritta a mano dopo il primo deploy.
const providers = new Map<string, OAuthProvider<Env>>();

function provider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: apiHandler as any,
      defaultHandler: authHandler as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      accessTokenTTL: 3600,
      refreshTokenTTL: 90 * 24 * 3600,
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: "Bacheca di Jarvis" },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return provider(new URL(request.url).origin).fetch(request, env, ctx);
  },
  // Ogni minuto: notifiche delle scadenze (avvisi.ts).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAlerts(env).then((r) => { if (r.fired || r.scanned) console.log("avvisi", JSON.stringify(r)); }));
  },
};
