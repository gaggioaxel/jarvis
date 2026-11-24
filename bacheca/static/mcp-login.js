// Login del connettore MCP (bacheca/mcp-worker). Il Worker manda qui con ?state=… dopo il consenso;
// si entra con lo stesso Google della bacheca e si torna al Worker con l'ID token nel frammento,
// che non finisce nei log. L'indirizzo del Worker viene da config.js (generato): il token va solo lì.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

const CONFIG = self.JARVIS || {};
const WORKER = (CONFIG.worker_url || "").replace(/\/$/, "");
const ALLOWED = (CONFIG.allowed_emails || []).map((e) => e.toLowerCase());

const $ = (id) => document.getElementById(id);
const state = new URLSearchParams(location.search).get("state");

function fail(message) {
  $("errore").textContent = message;
  $("errore").hidden = false;
  $("testo").hidden = true;
}

async function main() {
  if (!state) return fail("Manca lo stato della richiesta: riparti dal connettore in Claude.");
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(WORKER + "/")) return fail("Indirizzo del Worker non configurato (worker_url in config.js).");
  const cfg = await (await fetch("/__/firebase/init.json")).json();
  const auth = getAuth(initializeApp({ ...cfg, authDomain: location.host }));
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const enter = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      if (error.code === "auth/popup-blocked") return signInWithRedirect(auth, provider);
      if (error.code !== "auth/popup-closed-by-user") fail(error.message);
    }
  };

  $("continua").onclick = async () => {
    const user = auth.currentUser;
    if (!user) return enter();
    $("continua").disabled = true;
    const token = await user.getIdToken(true);
    location.replace(`${WORKER}/callback?state=${encodeURIComponent(state)}#id_token=${encodeURIComponent(token)}`);
  };
  $("altro").onclick = async () => {
    await signOut(auth);
    enter();
  };

  onAuthStateChanged(auth, (user) => {
    $("errore").hidden = true;
    $("testo").hidden = false;
    $("continua").hidden = false;
    $("continua").disabled = false;
    if (!user) {
      $("testo").textContent = "Entra con Google per dare a Claude l'accesso alla bacheca.";
      $("continua").textContent = "Entra con Google";
      $("altro").hidden = true;
    } else if (!ALLOWED.includes((user.email || "").toLowerCase()) || !user.emailVerified) {
      fail(`${user.email} non può usare la bacheca.`);
      $("continua").hidden = true;
      $("altro").hidden = false;
    } else {
      $("testo").textContent = `Collegare Claude alla bacheca come ${user.email}?`;
      $("continua").textContent = "Continua";
      $("altro").hidden = false;
    }
  });
}

main().catch((error) => fail(error.message));
