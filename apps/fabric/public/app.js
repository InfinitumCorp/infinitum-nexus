const signedOut = document.querySelector("#signed-out");
const app = document.querySelector("#app");
const errorBox = document.querySelector("#error");
const domain = document.querySelector("#domain");
const sessions = document.querySelector("#sessions");
const messages = document.querySelector("#messages");
const title = document.querySelector("#thread-title");
const text = document.querySelector("#text");
const sendButton = document.querySelector("#send");
let currentId = "";
let messageStamp = "";
let me = null;

function showError(message) {
  if (!message) {
    errorBox.hidden = true;
    errorBox.textContent = "";
    return;
  }
  errorBox.hidden = false;
  errorBox.textContent = message;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "request failed");
  return body;
}

function renderSessions(items) {
  sessions.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "meta";
    empty.textContent = "No conversations yet";
    sessions.append(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    if (item.id === currentId) button.setAttribute("aria-current", "true");
    const name = document.createElement("span");
    name.className = "session-name";
    name.textContent = item.peer.username;
    const preview = document.createElement("span");
    preview.className = "meta";
    preview.textContent = item.preview || "No messages";
    button.append(name, preview);
    button.addEventListener("click", () => selectSession(item));
    li.append(button);
    sessions.append(li);
  }
}

function renderMessages(items) {
  const stamp = items.map((item) => `${item.id}:${item.unreadable ? "x" : item.text}`).join("\n");
  if (stamp === messageStamp) return;
  messageStamp = stamp;
  messages.replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    if (me && item.sender === me.sub) li.className = "mine";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = item.username;
    const body = document.createElement("p");
    body.textContent = item.unreadable ? "This message could not be read." : item.text;
    const when = document.createElement("span");
    when.className = "meta";
    when.textContent = new Date(item.createdAt).toLocaleString();
    li.append(who, body, when);
    messages.append(li);
  }
  messages.scrollTop = messages.scrollHeight;
}

async function refreshSessions() {
  const body = await api("/api/sessions");
  renderSessions(body.sessions);
  return body.sessions;
}

async function selectSession(item) {
  currentId = item.id;
  title.textContent = item.peer.username;
  messageStamp = "";
  const body = await api(`/api/sessions/${item.id}/messages`);
  renderMessages(body.messages);
  await refreshSessions();
  text.focus();
}

async function refreshOpen() {
  if (!currentId) {
    await refreshSessions();
    return;
  }
  const body = await api(`/api/sessions/${currentId}/messages`);
  renderMessages(body.messages);
  await refreshSessions();
}

document.querySelector("#start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const username = document.querySelector("#peer").value.trim();
  try {
    const session = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username }),
    });
    document.querySelector("#peer").value = "";
    await selectSession(session);
  } catch (error) {
    showError(error.message);
  }
});

document.querySelector("#send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentId) {
    showError("Open a conversation first.");
    return;
  }
  showError("");
  sendButton.disabled = true;
  try {
    await api(`/api/sessions/${currentId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.value }),
    });
    text.value = "";
    messageStamp = "";
    await refreshOpen();
  } catch (error) {
    showError(error.message);
  } finally {
    sendButton.disabled = false;
  }
});

text.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.querySelector("#send-form").requestSubmit();
  }
});

document.querySelector("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/";
});

const params = new URLSearchParams(location.search);
if (params.get("error") === "sign-in-failed") showError("Sign-in failed. Try again.");

const config = await api("/api/config");
domain.textContent = config.rootDomain;

try {
  me = await api("/api/me");
  signedOut.hidden = true;
  app.hidden = false;
  title.textContent = `Signed in as ${me.username}`;
  await refreshSessions();
  setInterval(() => {
    refreshOpen().catch((error) => showError(error.message));
  }, 2000);
} catch {
  signedOut.hidden = false;
  app.hidden = true;
}
