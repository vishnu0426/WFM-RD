/* Usernames — application accounts, local credentials, username assignment.
   Wired to GraphQL `users` + REST /v1/users/:id/{credential,credential-status,
   username,reset-password,resend-invite,unlock}. */
import { Api } from '../../../core/api.js';
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, fmtDt, drawerShell } from '../shared/ui.js';
import { loadUsers, loadCredStatus } from '../shared/loaders.js';

export function renderDrawer(state) {
  const d = state.drawer;
  if (d === "invite") {
    return drawerShell("Invite user", "POST /v1/users/invite { email, givenName?, familyName? }",
      `<div class="field"><label>Email <span class="req">*</span></label><input type="email" id="invite-email" /></div>
       <div class="grid-2" style="margin-top:10px">
         <div class="field"><label>First name</label><input id="invite-given" /></div>
         <div class="field"><label>Last name</label><input id="invite-family" /></div>
       </div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="invite-go" ${state.wf.saving.invite ? "disabled" : ""}>${state.wf.saving.invite ? "Inviting…" : "Send invite"}</button>`);
  }
  if (d === "set-username") {
    const u = (state.wf.users || []).find((x) => x.id === state.usernameTarget);
    return drawerShell("Set username", "PATCH /v1/users/:id/username",
      `<div class="field"><label>Username</label><input id="username-input" value="${esc((u && u.username) || "")}" /></div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="username-go" ${state.wf.saving.username ? "disabled" : ""}>${state.wf.saving.username ? "Saving…" : "Save"}</button>`);
  }
  return "";
}

export function render(state) {
  if (!state.wf.users) {
    loadUsers(state);
    return pageHead("Usernames", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (state.userId === null && state.wf.users.length) state.userId = state.wf.users[0].id;
  const q = (state.userSearch || "").toLowerCase();
  const cred = state.userId ? state.wf.credStatus[state.userId] : undefined;
  const rows = state.wf.users.filter((u) => {
    if (q && !`${u.givenName || ""} ${u.familyName || ""} ${u.email} ${u.username || ""}`.toLowerCase().includes(q)) return false;
    if (state.userFilter.status && u.status !== state.userFilter.status) return false;
    if (state.userFilter.cred === "nopw" && cred && u.id === state.userId && cred.hasPassword) return false;
    return true;
  });
  const u = state.wf.users.find((x) => x.id === state.userId);
  if (u && !(u.id in state.wf.credStatus)) loadCredStatus(state, u.id);
  return `
    ${pageHead("Usernames", "Application accounts. Login is by email or the optional username column. Passwords are never shown.", `
      <button class="btn btn-primary" data-wf="open-invite">+ Invite user</button>`)}
    <div class="toolbar">
      <label class="search"><span>⌕</span><input data-wf="user-search" value="${esc(state.userSearch)}" placeholder="Name, email, username" /></label>
      <select data-wf="user-st"><option value="">Any status</option>${["ACTIVE", "INVITED", "DISABLED"].map((s) => `<option ${state.userFilter.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <span class="meta">${rows.length} users · GraphQL users</span>
    </div>
    <div class="split">
      <div class="split-l">
        ${rows.map((x) => `<button class="${x.id === state.userId ? "on" : ""}" data-wf="pick-user" data-id="${x.id}">
          <b>${esc(x.givenName || "")} ${esc(x.familyName || "")}</b>
          <div class="muted">${esc(x.email)}</div>
          ${stBadge(x.status)}
        </button>`).join("") || empty("No users found.", "Invite a user first.")}
      </div>
      <div class="split-r">
        ${u ? `
          <h2 style="margin:0 0 6px;font-size:16px">${esc(u.givenName || "")} ${esc(u.familyName || "")}</h2>
          <p class="muted">${esc(u.email)}${u.username ? ` · @${esc(u.username)}` : ""}</p>
          <div class="stat-row">
            ${stBadge(u.status)}
            ${cred && !cred.error ? `<span class="badge ${cred.hasPassword ? "badge-ok" : "badge-sys"}">${cred.hasPassword ? "Password set" : "No local password"}</span>` : ""}
            ${cred && cred.resetPending ? `<span class="badge badge-warn">Reset pending</span>` : ""}
            ${cred && cred.lockedUntil ? `<span class="badge badge-danger">Locked</span>` : ""}
          </div>
          ${sec("Account", cred === undefined
            ? `<div class="skel" style="height:16px"></div>`
            : cred.error
            ? `<p class="muted">${esc(cred.error)}</p>`
            : `<dl class="kv">
            <dt>Login (email)</dt><dd class="mono">${esc(u.email)}</dd>
            <dt>Username</dt><dd>
              <span class="mono">${esc(u.username || "—")}</span>
              <button class="btn btn-sm" style="margin-left:8px" data-wf="edit-username" data-id="${u.id}">Set…</button>
            </dd>
            <dt>Last login</dt><dd class="mono">${fmtDt(cred.lastLoginAt)}</dd>
            <dt>Failed attempts</dt><dd>${cred.failedLoginAttempts}</dd>
            <dt>Password updated</dt><dd class="mono">${fmtDt(cred.passwordUpdatedAt)}</dd>
          </dl>`)}
          ${sec("Set password", `<p class="hint">PUT /v1/users/:id/credential · min 12 characters. Value is write-only.</p>
            <div class="field"><label>New password</label><input type="password" id="pw-input-${u.id}" placeholder="••••••••••••" autocomplete="new-password" /></div>
            <button class="btn" style="margin-top:8px" data-wf="set-password" data-id="${u.id}" ${state.wf.saving.pw ? "disabled" : ""}>${state.wf.saving.pw ? "Saving…" : "Save password"}</button>`)}
          ${sec("Reset / unlock / invite", `
            <button class="btn" data-wf="reset-password" data-id="${u.id}">Force password reset</button>
            <button class="btn" data-wf="unlock-user" data-id="${u.id}" ${cred && cred.lockedUntil ? "" : "disabled"}>Unlock</button>
            ${u.status === "INVITED" ? `<button class="btn" data-wf="resend-invite" data-id="${u.id}">Resend invite</button>` : ""}
            <p class="hint">No email provider — the reset/invite link is logged server-side, not mailed.</p>`)}
        ` : empty("Select a user.", "Local credentials are managed per account.")}
      </div>
    </div>`;
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "open-invite") return set("drawer", "invite");
  if (act === "invite-go") {
    const email = $("#invite-email")?.value.trim();
    const givenName = $("#invite-given")?.value.trim();
    const familyName = $("#invite-family")?.value.trim();
    if (!email) {
      toast("Email is required.");
      return true;
    }
    state.wf.saving.invite = true;
    Api.rootApi("/v1/users/invite", { method: "POST", body: { email, givenName: givenName || undefined, familyName: familyName || undefined } })
      .then(() => {
        state.wf.saving.invite = false;
        state.wf.users = null; // force reload
        state.drawer = null;
        toast("User invited.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.invite = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "edit-username") {
    state.usernameTarget = id;
    return set("drawer", "set-username");
  }
  if (act === "username-go") {
    const username = $("#username-input")?.value.trim();
    if (!username) {
      toast("Username is required.");
      return true;
    }
    state.wf.saving.username = true;
    Api.rootApi(`/v1/users/${state.usernameTarget}/username`, { method: "PATCH", body: { username } })
      .then(() => {
        state.wf.saving.username = false;
        const u = state.wf.users.find((x) => x.id === state.usernameTarget);
        if (u) u.username = username;
        state.drawer = null;
        toast("Username updated.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.username = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "set-password") {
    const input = document.getElementById(`pw-input-${id}`);
    const password = input?.value || "";
    if (password.length < 12) {
      toast("Password must be at least 12 characters.");
      return true;
    }
    state.wf.saving.pw = true;
    Api.rootApi(`/v1/users/${id}/credential`, { method: "PUT", body: { password } })
      .then(() => {
        state.wf.saving.pw = false;
        delete state.wf.credStatus[id];
        toast("Password set.");
        loadCredStatus(state, id);
      })
      .catch((err) => {
        state.wf.saving.pw = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "reset-password") {
    Api.rootApi(`/v1/users/${id}/reset-password`, { method: "POST" })
      .then((r) => toast(`Reset link issued, expires ${new Date(r.expiresAt).toLocaleString()}.`))
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "resend-invite") {
    Api.rootApi(`/v1/users/${id}/resend-invite`, { method: "POST" })
      .then((r) => toast(`Invite resent, expires ${new Date(r.expiresAt).toLocaleString()}.`))
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "unlock-user") {
    Api.rootApi(`/v1/users/${id}/unlock`, { method: "POST" })
      .then(() => {
        delete state.wf.credStatus[id];
        toast("Account unlocked.");
        loadCredStatus(state, id);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
