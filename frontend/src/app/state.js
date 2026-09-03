/* The single shared app state singleton. Every module — roles.js and every
   identity-org feature module — reads/mutates this same object, exactly as
   the original app.js/workforce.js pairing did through their shared closure
   variable. Roles Setup fields are the base shape (this was app.js's own
   `state` object); `initState` (identity-org's own module) then fills in
   every other screen's defaults the first time it runs. */
import { initState } from '../modules/identity-org/state.js';
import { makeCurrentUser } from './current-user.js';

export function emptyWizard() {
  return {
    step: 1,
    name: "",
    description: "",
    isDefault: false,
    status: "active",
    organizationId: "",
    perms: new Set(),
    scope: "tenant",
    scopeOu: "",
    nameError: "",
  };
}

export const state = {
  module: "user-management",
  screen: "list",
  group: "Security",
  tab: "roles",
  search: "",
  sort: { key: "name", dir: 1 },
  filters: { defaultRole: "", org: "", status: "", module: "", users: "" },
  filterOpen: false,
  selected: new Set(),
  roleId: null,
  menu: null,
  toast: null,
  loading: false,
  failList: false,
  failMessage: "",
  wizard: emptyWizard(),
  permSearch: "",
  permGroup: "Security",
  permSelectedOnly: false,
  assign: { search: "", org: "", status: "", selected: new Set(), scope: "tenant", scopeOu: "" },
  dup: { name: "", description: "", copyPerms: true },
  edit: {},
  saving: false,
  me: null,
  data: {
    roles: null, // Role[] once loaded, each enriched with _permissionIds/_userCount
    permissions: null, // {id,resource,action}[]
    orgUnits: null, // flattened [{id,name,type,depth}]
    assignUsers: null, // full user list for the Assign Users drawer
  },
  roleUsers: {}, // roleId -> users-with-role rows
  roleActivity: {}, // roleId -> audit log entries
};

initState(state);

/* One shared instance — must be a singleton (not re-created per module) since
   login mutates its .permissions field in place (see app/shell.js's submit
   handler). Both roles.js and shell.js import this same object. */
export const currentUser = makeCurrentUser(state);
