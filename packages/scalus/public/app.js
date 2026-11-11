const tokenKey = "scalvs.token";
const $ = (id) => document.getElementById(id);

let agents = [];
let teams = [];

function token() {
  return sessionStorage.getItem(tokenKey) || "";
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function show(id, value) {
  $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function selectedTools(form) {
  return [...form.querySelectorAll("input[name=tool]:checked")].map((input) => input.value);
}

function fillSelect(id, items, label) {
  const select = $(id);
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = label(item);
    select.append(option);
  }
}

function render() {
  const list = $("agent-list");
  list.replaceChildren();
  for (const agent of agents) {
    const item = document.createElement("li");
    item.textContent = `${agent.name} (${agent.id}) · ${agent.role} · ${agent.tools.join(", ")}`;
    list.append(item);
  }
  fillSelect("run-agent", agents, (agent) => agent.name);
  fillSelect("vault-agent", agents, (agent) => agent.name);
  fillSelect("evidence-agent", agents, (agent) => agent.name);

  const members = $("team-members");
  members.replaceChildren();
  for (const agent of agents) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = "member";
    box.value = agent.id;
    label.append(box, document.createTextNode(` ${agent.name}`));
    members.append(label);
  }

  const teamList = $("team-list");
  teamList.replaceChildren();
  for (const team of teams) {
    const item = document.createElement("li");
    item.textContent = `${team.name} (${team.id}) · ${team.agentIds.join(", ")}`;
    teamList.append(item);
  }
  fillSelect("run-team", teams, (team) => team.name);
}

async function refresh() {
  agents = await api("GET", "/v1/agents");
  teams = await api("GET", "/v1/teams");
  render();
}

function signedIn(on) {
  $("workspace").hidden = !on;
  $("sign-out").hidden = !on;
}

async function signIn(value) {
  sessionStorage.setItem(tokenKey, value.trim());
  await api("GET", "/v1/tools");
  await refresh();
  signedIn(true);
  $("auth-status").textContent = "Signed in.";
}

$("sign-in-button").addEventListener("click", async () => {
  try {
    await signIn($("token").value);
  } catch (err) {
    sessionStorage.removeItem(tokenKey);
    signedIn(false);
    $("auth-status").textContent = err instanceof Error ? err.message : "Sign-in failed.";
  }
});

$("sign-out").addEventListener("click", () => {
  sessionStorage.removeItem(tokenKey);
  $("token").value = "";
  signedIn(false);
  $("auth-status").textContent = "Signed out.";
});

$("agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api("POST", "/v1/agents", {
      id: String(data.get("id") || ""),
      name: String(data.get("name") || ""),
      role: String(data.get("role") || ""),
      tools: selectedTools(form),
    });
    form.reset();
    await refresh();
  } catch (err) {
    show("run-output", err instanceof Error ? err.message : "Could not create the agent.");
  }
});

$("run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const agent = agents.find((item) => item.id === $("run-agent").value);
  if (!agent) return;
  try {
    const result = await api("POST", "/v1/agents/run", { ...agent, prompt: $("run-prompt").value });
    show("run-output", result);
    await showVault();
  } catch (err) {
    show("run-output", err instanceof Error ? err.message : "Run failed.");
  }
});

$("team-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const agentIds = [...form.querySelectorAll("input[name=member]:checked")].map((input) => input.value);
  try {
    await api("POST", "/v1/teams", {
      id: String(data.get("id") || ""),
      name: String(data.get("name") || ""),
      agentIds,
    });
    form.reset();
    await refresh();
  } catch (err) {
    show("team-output", err instanceof Error ? err.message : "Could not create the team.");
  }
});

$("team-run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const team = teams.find((item) => item.id === $("run-team").value);
  if (!team) return;
  const members = team.agentIds.map((id) => agents.find((agent) => agent.id === id)).filter(Boolean);
  try {
    const result = await api("POST", "/v1/team/run", { prompt: $("team-prompt").value, agents: members });
    show("team-output", result);
  } catch (err) {
    show("team-output", err instanceof Error ? err.message : "Team run failed.");
  }
});

async function showVault() {
  const agentId = $("vault-agent").value;
  if (!agentId) {
    show("vault-output", []);
    return;
  }
  show("vault-output", await api("GET", `/v1/memory/${encodeURIComponent(agentId)}`));
}

$("vault-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("POST", "/v1/memory", { agentId: $("vault-agent").value, content: $("vault-note").value, tags: ["note"] });
    $("vault-note").value = "";
    await showVault();
  } catch (err) {
    show("vault-output", err instanceof Error ? err.message : "Could not remember.");
  }
});

$("vault-refresh").addEventListener("click", () => showVault().catch((err) => show("vault-output", err.message)));

$("vault-anchor").addEventListener("click", async () => {
  try {
    const saved = await api("POST", "/v1/memory/persist", {
      agentId: $("vault-agent").value,
      content: $("vault-note").value || "anchored",
      tags: ["firm"],
    });
    show("vault-output", saved);
  } catch (err) {
    show("vault-output", err instanceof Error ? err.message : "Could not anchor.");
  }
});

$("vault-clear").addEventListener("click", async () => {
  try {
    await api("POST", `/v1/memory/${encodeURIComponent($("vault-agent").value)}/clear`, {});
    await showVault();
  } catch (err) {
    show("vault-output", err instanceof Error ? err.message : "Could not clear.");
  }
});

$("evidence-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const agent = agents.find((item) => item.id === $("evidence-agent").value);
  if (!agent) return;
  try {
    const evidence = await api("POST", "/v1/evidence", { ...agent, prompt: $("evidence-prompt").value });
    show("evidence-output", evidence);
  } catch (err) {
    show("evidence-output", err instanceof Error ? err.message : "Could not record evidence.");
  }
});

if (token()) {
  $("token").value = token();
  signIn(token()).catch(() => {
    sessionStorage.removeItem(tokenKey);
    signedIn(false);
  });
}
