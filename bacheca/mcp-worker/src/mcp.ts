// Trasporto MCP "Streamable HTTP" senza stato: ogni POST porta uno o più messaggi JSON-RPC
// e riceve la risposta come application/json. Niente sessioni né SSE: gli strumenti sono richieste brevi.
import { Env, Store } from "./firestore";
import { callTool, toolList } from "./tools";
import { CFG, configure } from "./config";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];

async function handle(msg: any, store: Store) {
  const params = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "bacheca", title: "Bacheca di Jarvis", version: "1.0" },
        instructions: `Bacheca di Jarvis (Trello personale di ${CFG.owner} su Firestore). ` +
          `Ogni scheda si apre da ${CFG.url}/#c/<id scheda>.`,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: toolList() };
    case "tools/call": {
      const result = await callTool(store, params.name, params.arguments || {});
      if (!result) throw Object.assign(new Error(`Strumento sconosciuto: ${params.name}`), { code: -32602 });
      return { content: [{ type: "text", text: result.text }], isError: result.isError };
    }
    default:
      throw Object.assign(new Error(`Metodo non supportato: ${msg.method}`), { code: -32601 });
  }
}

async function answer(msg: any, store: Store) {
  if (msg === null || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Richiesta non valida" } };
  }
  if (!("id" in msg)) return null; // notifiche e risposte: niente da restituire
  try {
    return { jsonrpc: "2.0", id: msg.id, result: await handle(msg, store) };
  } catch (error: any) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: error.code ?? -32603, message: error.message } };
  }
}

export async function mcpFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Questo server MCP non apre stream: usa POST.", { status: 405, headers: { Allow: "POST" } });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON non valido" } }, { status: 400 });
  }
  configure(env);
  const store = new Store(env);
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((m: any) => answer(m, store)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
