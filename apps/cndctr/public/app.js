const signedOut = document.querySelector("#signed-out");
const app = document.querySelector("#app");
const errorBox = document.querySelector("#error");
const who = document.querySelector("#who");
const intent = document.querySelector("#intent");
const autonomy = document.querySelector("#autonomy");
const out = document.querySelector("#out");
const performButton = document.querySelector("#perform");
const form = document.querySelector("#perform-form");
const logout = document.querySelector("#logout");

function showError(message) {
  if (!message) {
    errorBox.hidden = true;
    errorBox.textContent = "";
    return;
  }
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function showApp(me) {
  signedOut.hidden = true;
  app.hidden = false;
  who.textContent = me.name || me.username;
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "request failed");
    error.status = response.status;
    throw error;
  }
  return body;
}

function render(body) {
  const verified = Boolean(body.performance && body.performance.verified === true);
  out.dataset.state = verified ? "verified" : "rejected";
  const lines = [verified ? "Verified" : "Not verified"];
  if (body.score && body.score.title) lines.push(body.score.title);
  const evidence = body.performance && Array.isArray(body.performance.evidence) ? body.performance.evidence : [];
  for (const line of evidence) lines.push(String(line));
  lines.push(JSON.stringify(body, null, 2));
  out.textContent = lines.join("\n\n");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  performButton.disabled = true;
  try {
    const response = await fetch("/api/perform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: intent.value, autonomy: autonomy.value }),
    });
    render(await readJson(response));
  } catch (error) {
    if (error.status === 401) {
      app.hidden = true;
      signedOut.hidden = false;
    }
    showError(error.message || "Perform failed");
  } finally {
    performButton.disabled = false;
  }
});

/** The Cumulus://ID account bar shows who is signed in to this CNDCTR session. */
function showAccount(me) {
  window.CumulusBar?.setProfile(me ? { name: me.name || me.username, username: me.username, email: me.email || undefined } : null);
}
let account = null;
window.addEventListener("load", () => showAccount(account));

async function signOut() {
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok && response.status !== 204) {
    showError("Sign out failed");
    return;
  }
  app.hidden = true;
  signedOut.hidden = false;
  out.textContent = "";
  delete out.dataset.state;
  who.textContent = "";
  account = null;
  showAccount(null);
}

logout.addEventListener("click", signOut);
// The account bar's "Sign out" navigates to #signout (data-signout).
const onSignoutHash = () => {
  if (location.hash !== "#signout") return;
  history.replaceState(null, "", location.pathname + location.search);
  signOut();
};
window.addEventListener("hashchange", onSignoutHash);

async function refresh() {
  const params = new URLSearchParams(location.search);
  if (params.get("error") === "sign-in-failed") showError("Sign-in failed. Try again with your Cumulus ID.");
  const response = await fetch("/api/me");
  if (response.status === 401) return;
  account = await readJson(response);
  showApp(account);
  showAccount(account);
}

refresh().catch((error) => showError(error.message || "Could not reach CNDCTR"));
