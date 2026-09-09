# `_shared/engine.js` — the rules, made readable to Deno

`engine.js` in this directory is **generated**. It is not in git, and editing it
would be editing a build product. If it is missing, or the function is behaving
like a version of the rules you do not recognise:

```sh
npm run functions:build
```

`npm run functions:deploy` runs that first, so the deployed bundle is always the
one built from the working tree.

## Why a bundle exists at all

The Edge Function is the referee. It has to call `applyCommand`, build a
scenario and redact a board, which means it has to call the same engine the
browser calls — a second implementation would be a second set of rules, and two
sets of rules is no rules.

It cannot call the engine as source. Two conventions this codebase relies on are
TypeScript's and not Deno's:

- relative imports carry a `.js` extension that points at a `.ts` file;
- modules reach across the tree with `@engine/`, `@net/`, `@scenarios/` aliases
  declared in `tsconfig.json`.

Deno resolves neither. There is a third obstacle underneath those two: the
Supabase CLI uploads `supabase/functions` and nothing above it, so even a Deno
that understood the imports could not follow them out of this directory and into
`src/`.

So `scripts/build-functions.mjs` runs esbuild over an entry point that re-exports
the handful of names the function actually uses, pointed at the project's own
`tsconfig.json` — which is what makes the aliases and the extension convention
resolve, using the same configuration the browser build uses rather than a
second copy of it. The output is one ESM file with no imports left in it.

## What is in it

Only what the function calls, and what that pulls in behind it: the protocol's
request parser, the referee, `sealDie`, `buildScenario` and the scenario table,
and the default map. The list is written out by hand at the top of the build
script, because a bundle is a contract between two separately deployed programs
and `export *` is not a contract anybody can read.

## `engine.d.ts`

Also generated, also ignored, and pointed at the sources rather than at the
bundle: esbuild erases types and cannot emit declarations, and a hand-written
declaration file would be a second copy of the contract free to drift from the
first. Re-exporting from `src/` gives an editor the real, current types, because
TypeScript resolves `./x.js` to `./x.ts` and follows the path aliases the same
way the build does.

Deno never reads it. It consults a sibling declaration only when a
`@deno-types` comment points at one, and nothing here does — which is the
intention, since the `.ts` sources it names are exactly what Deno cannot follow.

## Verifying it

The build imports its own output, builds a scenario, judges a legal order and
then a spectator's illegal one, and fails if the game that comes back is not a
real one. A bundle that builds and throws on import is worse than no bundle,
because the failure surfaces in production instead of at the desk.

`node scripts/build-functions.mjs --check` runs that check alone, against the
bundle already on disk.
