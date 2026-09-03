# ADR-0147: WCAG 2.1 AA is Module 11's explicit accessibility target, enforced from Phase 1 and audited at every phase's release gate

## Context

The source spec's §5c flags accessibility as a first-sprint requirement,
"not a retrofit," required for government/enterprise procurement, and asks
for an explicit target standard plus an audit-as-release-gate approach —
but doesn't itself name the standard or say how "automated where tooling
allows" concretely gets enforced. `mobile-app/` is also the first
client/frontend of any kind in this platform, so there's no existing
accessibility tooling or convention anywhere in the repo to inherit.

## Decision

**Target standard**: WCAG 2.1 AA, applied to the mobile context via
platform accessibility guidelines (iOS Human Interface Guidelines
accessibility section, Android accessibility guidelines), per the source
spec's own instruction.

**Enforced from Phase 1, concretely**, not just stated as a goal:
- A shared `Touchable`/`Button` primitive (`src/components/ui/`) enforcing
  the 44×44pt (iOS)/48×48dp (Android) minimum hit target in one place,
  used instead of ad hoc `Pressable`s.
- `accessibilityLabel`/`accessibilityRole`/`accessibilityState` set on every
  interactive element, enforced automatically by
  `eslint-plugin-react-native-a11y` wired into `npm run lint`.
- A design-tokens color file (`src/lib/a11y/tokens.ts`) where every
  foreground/background pair is asserted against a hand-implemented WCAG
  contrast-ratio checker (`src/lib/a11y/contrast.ts`, 4.5:1 normal text /
  3:1 large text & UI) in a unit test — a pair can't be added without also
  being added to that test.
- RN's default text scaling is left enabled everywhere (no
  `allowFontScaling={false}`).

**Audit-as-release-gate**: the `mobile-app` CI job (added to
`.github/workflows/ci.yml` in this phase) runs `npm run lint` — which
includes the a11y plugin — on every PR, so a missing label/role/insufficient
target size fails CI the same way a functional test failure would. This is
the "automated CI check where tooling allows" the source spec's §6 asks
for; what automated tooling can't catch (actual screen-reader behavior,
real-device text-scaling layout) remains a manual audit step for each
later phase's own UI work, not covered by this ADR.

One deliberate narrowing: `eslint-plugin-react-native-a11y`'s `all` preset
includes `has-accessibility-hint`, which flags every `accessibilityLabel`
regardless of whether the element is interactive. `accessibilityHint`
describes the *result of an action* per Apple/RN guidance — meaningful for
buttons, not for passive status/text/progress content. That single rule is
disabled (`.eslintrc.js`); every other rule in the preset stays on.

## Consequences

- Every future Module 11 screen inherits this baseline by construction (the
  shared `Touchable`/`Button`, the token file, the lint rule) rather than
  needing to rediscover it — the cost of accessibility compliance is paid
  once, in Phase 1, not per-screen later.
- CI will fail a PR that adds an interactive element without an
  accessibility label/role, or a new color pair that hasn't been verified
  against `contrast.ts`'s thresholds.
- Manual, device-level accessibility audit (VoiceOver/TalkBack behavior,
  real text-scaling layout at 200%) is explicitly not automated by this
  phase and must be a stated step in each later phase's own release
  checklist, not assumed to be covered by CI alone.
