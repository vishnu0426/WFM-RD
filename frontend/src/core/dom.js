/* Generic, framework-agnostic DOM/string helpers shared by every module. */
export const $ = (sel, el = document) => el.querySelector(sel);

export function esc(s) {
  const amp = '&' + 'amp;', lt = '&' + 'lt;', gt = '&' + 'gt;', quot = '&' + 'quot;';
  return String(s ?? '').replace(/&/g, amp).replace(/</g, lt).replace(/>/g, gt).replace(/"/g, quot);
}

export function errMsg(err) {
  return (err && err.message) || 'Something went wrong.';
}
