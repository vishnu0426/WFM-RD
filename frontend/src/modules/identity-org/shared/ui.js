/* Page-layout / badge helpers shared across the identity-org module's
   screens (Profiles, Groups, Schedule Preferences, Time Off, Skills, Work
   Rules, Interactions, Staffing Profile). */
export function typeLabel(t) {
  return ({ FULL_TIME: "Full time", PART_TIME: "Part time", CONTRACTOR: "Contractor", SEASONAL: "Seasonal" }[t] || t);
}

export function stBadge(s) {
  const map = {
    ACTIVE: ["badge-ok", "Active"], ON_LEAVE: ["badge-warn", "On leave"],
    TERMINATED: ["badge-off", "Terminated"], PENDING_ONBOARDING: ["badge-sys", "Pending"],
    DISABLED: ["badge-off", "Disabled"], INVITED: ["badge-warn", "Invited"],
    active: ["badge-ok", "Active"], on_leave: ["badge-warn", "On leave"],
    terminated: ["badge-off", "Terminated"], pending_onboarding: ["badge-sys", "Pending"],
    disabled: ["badge-off", "Disabled"],
    pending: ["badge-warn", "Pending"], approved: ["badge-ok", "Approved"],
    rejected: ["badge-danger", "Rejected"], cancelled: ["badge-off", "Cancelled"],
  };
  const [c, l] = map[s] || ["badge-sys", s];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

export function pageHead(title, desc, actions) {
  return `<div class="page-head"><div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions || ""}</div></div>`;
}

export function gap(text) {
  return `<span class="badge badge-warn">BACKEND GAP</span> <span class="muted">${text}</span>`;
}

export function sec(title, body, extra = "") {
  return `<section class="sec"><h3>${title} ${extra}</h3><div class="body">${body}</div></section>`;
}

export function empty(h, p, cta) {
  return `<div class="empty"><h2>${h}</h2><p>${p || ""}</p>${cta || ""}</div>`;
}

export function fmtDt(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function drawerShell(title, sub, body, left, right) {
  return `<div class="drawer-scrim" data-wf="close-drawer"><div class="drawer" role="dialog" aria-modal="true">
    <div class="drawer-h"><div><h2>${title}</h2><p>${sub}</p></div><button class="icon-btn" data-wf="close-drawer">×</button></div>
    <div class="drawer-b">${body}</div>
    <div class="drawer-f"><div>${left}</div><div class="actions">${right}</div></div>
  </div></div>`;
}
