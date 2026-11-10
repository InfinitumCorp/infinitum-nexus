const $ = id => document.getElementById(id);
const state = { repos: [], repo: null, branch: 'main', history: [], commit: null, product: document.documentElement.dataset.product ?? 'spectre', dirty: false, busy: false, binary: null, sourceBytes: null, audit: [], identity: null };
const notice = message => { $('notice').textContent = message; };
class RequestError extends Error { constructor(status) { super(({ 400: 'Invalid name, path or request. Check the entered values.', 401: 'Your Cumulus://ID session is missing or expired. Sign in through the host product.', 403: 'Access denied. Check your organization plan, repository role and consent permissions.', 404: 'This file or version was not found. Refresh the repository.', 409: 'The branch changed since you opened it. Your text is preserved. Copy your changes, refresh, then apply them to the latest version.', 413: 'This artifact exceeds the HTTP request limit. Use a smaller text file.', 429: 'The organization request or storage limit was reached. Wait a minute before retrying, or ask your administrator.', 503: 'Labyrinth is not configured on this host. An operator must configure encrypted storage and organization entitlements.' })[status] ?? 'Labyrinth is unavailable. Your unsaved text is preserved.'); this.status = status; } }
async function rpc(action, args = {}) {
  const response = await fetch('/api/labyrinth', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json', 'x-labyrinth': '1' }, body: JSON.stringify({ action, product: state.product, ...args }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new RequestError(response.status);
  return response.json();
}
async function run(task) {
  if (state.busy) return;
  state.busy = true;
  const enabled = [...document.querySelectorAll('button,select,input,textarea')].filter(el => !el.disabled);
  enabled.forEach(el => el.disabled = true);
  try { await task(); } catch (error) { notice(error instanceof RequestError ? error.message : 'Connection failed. Your unsaved text is preserved. Reconnect and try again.'); }
  finally { state.busy = false; enabled.forEach(el => el.disabled = false); }
}
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function option(value, label) { const el = element('option', label); el.value = value; return el; }
function table(target, columns, rows) {
  const t = element('table'); const head = element('tr'); columns.forEach(c => head.append(element('th', c))); const thead = element('thead'); thead.append(head); t.append(thead);
  const body = element('tbody'); rows.forEach(row => { const tr = element('tr'); row.forEach(value => tr.append(element('td', String(value ?? '—')))); body.append(tr); }); t.append(body); $(target).replaceChildren(t);
}
function discard() { return !state.dirty || window.confirm('Discard unsaved file changes?'); }
function clearEditor() { $('editor').reset(); $('content').readOnly = false; state.binary = null; state.sourceBytes = null; state.dirty = false; }
function clearPrivateState() {
  state.repos = []; state.repo = null; state.history = []; state.commit = null; state.audit = [];
  for (const id of ['repositories', 'files', 'history', 'members', 'audit', 'changes', 'tags']) $(id).replaceChildren();
  clearEditor(); $('repo-detail').hidden = true; $('more-audit').hidden = true;
}
async function connect() {
  try {
    const session = await rpc('session');
    $('create-organization').hidden = !!session.organization;
    if (!session.organization) {
      clearPrivateState(); state.identity = session.cid;
      $('identity').textContent = session.cid;
      $('connect').hidden = false; $('app').hidden = true; $('provision').hidden = true;
      notice('Signed in. Create your organization in First-time organization setup.'); return;
    }
    const identity = `${session.cid}/${session.organization.id}`;
    if (state.identity !== identity) clearPrivateState();
    state.identity = identity;
    $('identity').textContent = `${session.organization.name} / ${session.cid} · ${session.organization.id}`;
    $('provision').hidden = !session.organization.admin;
    $('consent-level').value = session.scopes.includes('repo:admin') ? 'admin' : session.scopes.includes('repo:write') ? 'write' : 'read';
    await list(); $('connect').hidden = true; $('app').hidden = false;
    notice('Workspace connected. All repositories are private.');
  } catch (error) { if (error.status === 401) { clearPrivateState(); state.identity = null; $('identity').textContent = 'Cumulus://ID sign-in required'; } $('connect').hidden = false; $('app').hidden = true; throw error; }
}
function renderRepos() {
  $('repo-count').textContent = String(state.repos.length);
  $('repositories').replaceChildren(...state.repos.map(repo => { const b = element('button', repo.name, 'repo-link'); b.type = 'button'; b.setAttribute('aria-current', String(repo.id === state.repo?.id)); b.addEventListener('click', () => run(async () => { if (!discard()) return; state.repo = repo; state.branch = Object.hasOwn(repo.branches, 'main') ? 'main' : Object.keys(repo.branches)[0]; clearEditor(); await openRepo(); })); return b; }));
}
async function list() {
  state.repos = await rpc('list');
  if (state.repo) state.repo = state.repos.find(repo => repo.id === state.repo.id) ?? null;
  renderRepos();
  if (state.repo) await openRepo();
  else { $('repo-detail').hidden = true; $('empty').hidden = false; $('repo-title').textContent = 'Select a repository.'; }
}
async function openRepo() {
  const repo = state.repo; if (!repo) return;
  $('repo-title').textContent = repo.name; $('empty').hidden = true; $('repo-detail').hidden = false;
  if (!Object.hasOwn(repo.branches, state.branch)) state.branch = Object.keys(repo.branches)[0];
  $('branch').replaceChildren(...Object.keys(repo.branches).map(name => option(name, name))); $('branch').value = state.branch;
  state.history = await rpc('history', { repo: repo.id, branch: state.branch, limit: 100 });
  state.commit = state.history[0] ?? null;
  $('revision').replaceChildren(...state.history.map(c => option(c.id, `${c.id.slice(0, 9)} — ${c.message}`)));
  if (!state.history.length) $('revision').append(option('', 'No commits yet'));
  renderHistory();
  $('tags').textContent = Object.entries(repo.tags).map(([name, id]) => `${name} → ${id.slice(0, 10)}`).join(' · ') || 'No tags yet.';
  $('changes').textContent = ''; renderFiles(); renderRepos();
}
function renderHistory() {
  $('history').replaceChildren(...state.history.map(c => { const b = element('button', `${c.id.slice(0, 10)} · ${c.message} · ${new Date(c.at).toLocaleString()}`, 'history-link'); b.type = 'button'; b.addEventListener('click', () => { if (state.busy || !discard()) return; state.commit = c; $('revision').value = c.id; clearEditor(); renderFiles(); }); return b; }));
  $('more-history').hidden = !state.history.at(-1)?.parent;
}
function showBytes(bytes) {
  state.binary = null; state.sourceBytes = bytes; $('content').readOnly = false;
  try {
    if (bytes.includes(0)) throw new Error('binary');
    $('content').value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { state.binary = bytes; $('content').readOnly = true; $('content').value = `Binary artifact · ${bytes.length.toLocaleString()} bytes\n\nDownload to view, or import a replacement file to commit a new version.`; }
}
function base64(bytes) {
  let result = ''; for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(result);
}
function renderFiles() {
  const prefix = `products/${state.product}/`;
  const paths = Object.keys(state.commit?.tree ?? {}).filter(path => path.startsWith(prefix)).sort();
  $('files').replaceChildren(...paths.map(path => {
    const relative = path.slice(prefix.length); const b = element('button', relative, 'file-link'); b.type = 'button';
    b.addEventListener('click', () => run(async () => {
      if (!discard()) return;
      const result = await rpc('load', { repo: state.repo.id, commit: state.commit.id, path: relative, encoding: 'base64' });
      $('file-path').value = relative; showBytes(Uint8Array.from(atob(result.content), c => c.charCodeAt(0)));  $('message').value = ''; state.dirty = false;
      notice(`Opened ${relative} at ${state.commit.id.slice(0, 10)}.`);
    })); return b;
  }));
  if (!paths.length) $('files').append(element('p', 'No artifacts for this product in this version.', 'muted'));
}
function bind(id, event, task) { $(id).addEventListener(event, e => { e.preventDefault(); void run(() => task(e)); }); }
function head() {
  if (!state.repo) throw new RequestError(404);
  const expected = state.repo.branches[state.branch];
  if ((state.commit?.id ?? null) !== expected) throw new Error('historical');
  return expected;
}
async function afterChange(message) { state.dirty = false; await list(); notice(message); }
bind('create-organization', 'submit', async () => { await rpc('organization', { name: $('organization-name').value.trim() }); await connect(); });
bind('retry', 'click', connect);
bind('refresh', 'click', async () => { if (!discard()) return; clearEditor(); await connect(); });
bind('consent', 'click', async () => { const scopes = ['repo:read']; if (['write', 'admin'].includes($('consent-level').value)) scopes.push('repo:write'); if ($('consent-level').value === 'admin') scopes.push('repo:admin'); await rpc('consent', { scopes }); notice('Permissions recorded. An entitled organization admin may now provision the workspace.'); });
bind('provision', 'click', async () => { await rpc('provision'); await connect(); });
bind('create-repo', 'submit', async () => { if (!discard()) return; const repo = await rpc('create', { name: $('repo-name').value.trim() }); state.repo = repo; state.branch = 'main'; $('create-repo').reset(); clearEditor(); await afterChange('Private repository created.'); });
bind('product', 'change', async () => { if (!discard()) { $('product').value = state.product; return; } state.product = $('product').value; clearEditor(); renderFiles(); notice('Product artifact namespace selected.'); });
bind('branch', 'change', async () => { if (!discard()) { $('branch').value = state.branch; return; } state.branch = $('branch').value; clearEditor(); await openRepo(); });
bind('revision', 'change', async () => { if (!discard()) { $('revision').value = state.commit?.id ?? ''; return; } state.commit = state.history.find(c => c.id === $('revision').value) ?? null; clearEditor(); renderFiles(); notice('Historical version selected. Select the branch head before committing.'); });
bind('editor', 'submit', async () => {
  let expectedHead; try { expectedHead = head(); } catch { notice('Select the latest version before committing. Your text is preserved.'); return; }
  await rpc('save', { repo: state.repo.id, branch: state.branch, path: $('file-path').value.trim(), content: state.sourceBytes ? base64(state.sourceBytes) : $('content').value, encoding: state.sourceBytes ? 'base64' : 'utf-8', expectedHead, message: $('message').value.trim() });
  await afterChange('Change committed. Earlier versions remain available.');
});
bind('remove', 'click', async () => {
  let expectedHead; try { expectedHead = head(); } catch { notice('Select the latest version before deleting.'); return; }
  const path = $('file-path').value.trim(); if (!path || !expectedHead || !Object.hasOwn(state.commit.tree, `products/${state.product}/${path}`)) { notice('Select an existing file to delete.'); return; }
  if (!window.confirm(`Delete ${path} from ${state.branch}? Earlier versions will retain it.`)) return;
  await rpc('remove', { repo: state.repo.id, branch: state.branch, path, expectedHead, message: $('message').value.trim() || `Delete ${path}` }); clearEditor(); await afterChange('File deleted in a new commit.');
});
bind('download', 'click', async () => {
  if (!$('file-path').value) return;
  const blob = URL.createObjectURL(new Blob([state.sourceBytes ?? $('content').value], { type: state.binary ? 'application/octet-stream' : 'text/plain;charset=utf-8' }));
  const a = element('a'); a.href = blob; a.download = $('file-path').value.split('/').pop(); a.click(); setTimeout(() => URL.revokeObjectURL(blob), 1000);
});
bind('create-branch', 'submit', async () => { if (!discard()) return; const name = $('branch-name').value.trim(); await rpc('branch', { repo: state.repo.id, name, from: state.commit?.id ?? null }); state.branch = name; clearEditor(); $('create-branch').reset(); await afterChange('Branch created from the selected version.'); });
bind('create-tag', 'submit', async () => { if (!state.commit) { notice('Commit a file before creating a tag.'); return; } await rpc('tag', { repo: state.repo.id, name: $('tag-name').value.trim(), commit: state.commit.id }); $('create-tag').reset(); const repo = state.repos.find(r => r.id === state.repo.id); if (repo) { const updated = (await rpc('list')).find(r => r.id === repo.id); if (updated) { state.repo.tags = updated.tags; $('tags').textContent = Object.entries(updated.tags).map(([name, id]) => `${name} → ${id.slice(0, 10)}`).join(' · '); } } notice('Immutable tag created.'); });
bind('more-history', 'click', async () => {
  const before = state.history.at(-1)?.id; if (!before) return;
  const earlier = await rpc('history', { repo: state.repo.id, branch: state.branch, limit: 100, before });
  state.history.push(...earlier);
  $('revision').append(...earlier.map(c => option(c.id, `${c.id.slice(0, 9)} — ${c.message}`)));
  renderHistory(); notice(`${state.history.length} versions loaded.`);
});
bind('diff', 'click', async () => { if (!state.commit) return; const changes = await rpc('diff', { repo: state.repo.id, from: state.commit.parent, to: state.commit.id }); $('changes').textContent = changes.map(c => `${c.kind.toUpperCase()}  ${c.path}\n  ${c.before ?? '∅'} → ${c.after ?? '∅'}`).join('\n\n') || 'No file changes.'; });
async function loadMembers() { const members = await rpc('members'); table('members', ['Member CID', 'Role'], members.map(m => [m.cid, m.role])); }
bind('load-members', 'click', loadMembers);
bind('set-member', 'submit', async () => { const memberRole = $('member-role').value; if (!window.confirm('Apply this organization repository access change?')) return; await rpc('set-member', { member: $('member-cid').value.trim(), memberRole: memberRole === 'remove' ? null : memberRole }); await loadMembers(); notice('Member access updated.'); });
async function loadAudit(reset = false) {
  if (reset) state.audit = [];
  const entries = await rpc('audit', { after: state.audit.at(-1)?.sequence ?? 0, limit: 100 });
  state.audit.push(...entries);
  table('audit', ['#', 'Time', 'Actor', 'Operation', 'Repository', 'Hash'], state.audit.map(e => [e.sequence, new Date(e.at).toLocaleString(), e.actor, e.action, e.repoId, e.hash]));
  $('more-audit').hidden = entries.length < 100;
  notice(`${state.audit.length} accepted audit entries loaded.`);
}
bind('load-audit', 'click', () => loadAudit(true));
bind('more-audit', 'click', () => loadAudit());
bind('artifact-upload', 'change', async () => {
  const file = $('artifact-upload').files[0]; if (!file) return;
  if (file.size > 1024 * 1024) { notice('Import a file up to 1 MiB. Larger artifacts require the server SDK.'); $('artifact-upload').value = ''; return; }
  showBytes(new Uint8Array(await file.arrayBuffer()));
  if (!$('file-path').value) $('file-path').value = file.name;
  state.dirty = true; $('artifact-upload').value = ''; notice('Artifact imported. Enter a commit message to save this version.');
});
$('editor').addEventListener('input', event => { state.dirty = true; if (event.target.id === 'content') state.sourceBytes = null; });
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
$('product').value = state.product;
void run(connect);
