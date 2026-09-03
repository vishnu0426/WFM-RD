# ADR-0148: `mobile-app/` is a standalone Expo (managed workflow) TypeScript package, not a bare React Native CLI project or part of a shared workspace

## Context

The source spec mandates React Native and explicitly rules out a separate
native iOS/Android codebase or a separate mobile-specific backend (§1). It
doesn't mandate managed vs. bare React Native, or where/how the app's
package should sit relative to the rest of the repo.

Two decisions were needed before scaffolding anything: Expo managed
workflow vs. bare React Native CLI, and whether the new app should join an
existing monorepo workspace or stand alone. On the second question,
investigation confirmed there is no monorepo tool anywhere in this repo
(no turborepo.json/nx.json/pnpm-workspace.yaml/lerna.json, and no
`workspaces` field in any `package.json`) — every existing service
(`attendance-leave-service`, `shift-marketplace-service`, etc.) is a fully
independent package with its own `package.json`, own lint/test scripts, own
deployment.

## Decision

**Expo, managed workflow.** No native `ios/`/`android/` project folders are
committed; native configuration lives in `app.config.ts` and is realized at
build time via EAS Build. Chosen over bare React Native CLI because this
environment has no Xcode/Android Studio to build or run a native project
against — a bare RN scaffold's native folders would be unbuildable and
unverifiable here, while Expo's managed APIs (`expo-secure-store`,
`expo-local-authentication`, `expo-location`, `expo-notifications` — all
first-party, all needed by later phases' §5a/§5b/Phase 5 requirements) cover
every native capability this module needs without ejecting.

**Standalone package at `mobile-app/`, not a workspace member.** Matches
every other service in this repo exactly: own `package.json`,
`package-lock.json`, `.eslintrc.js`, `tsconfig.json`, `jest.config.js` —
nothing shared or hoisted. There is no existing workspace to join, and
introducing one now would be a repo-wide tooling change well outside this
module's scope.

**Expo Router** for navigation, not React Navigation configured by hand —
it's built on React Navigation (so the same primitives are available where
needed) but adds file-based routing and the deep-linking scaffolding that
Phase 5's push notifications will need to route a tapped notification to a
specific screen.

## Consequences

- iOS/Android-specific behavior (safe areas, native accessibility APIs,
  actual biometric prompts once Phase 2 lands) can only be verified
  structurally through tests and `npm run web` in this environment, not
  through a real device/simulator run, unless one is confirmed available.
  State this limitation explicitly wherever "verified" claims are made for
  this module, rather than implying full device verification happened.
- Native module version compatibility is managed via `npx expo install`
  (SDK-aware) rather than hand-picked `npm install` versions, for every
  package with a native component.
- If a future phase needs a capability Expo's managed workflow genuinely
  can't provide, that's a new decision point requiring its own ADR (likely
  evaluating a config plugin or, as a last resort, ejecting) — not silently
  worked around.
