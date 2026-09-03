/* Every feature module's async loader needs to trigger a re-render after
   mutating shared state, but only app/shell.js owns the actual render loop —
   this indirection avoids a circular import between shell.js and every
   module that loads data. shell.js calls setRerender(render) once at boot. */
let impl = () => {};

export function setRerender(fn) {
  impl = fn;
}

export function doRerender() {
  impl();
}
