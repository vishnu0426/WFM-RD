/* Same indirection as rerender.js — only app/shell.js owns the actual toast
   UI + state.toast, every module just calls toast(msg). */
let impl = (msg) => console.warn('[toast before shell mounted]', msg);

export function setToastImpl(fn) {
  impl = fn;
}

export function toast(msg) {
  impl(msg);
}
