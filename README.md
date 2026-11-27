# Devtools

A monorepo for independently versioned professional tools.

## Contents

Tools by type. To use one, open its README and follow **Setup**.

### Chrome extensions

- [HeaderLab](tools/headerlab/README.md): manages request headers, query
  parameters and cookies for selected sites.
  [Setup](tools/headerlab/README.md#setup)

## Setup

Use Node.js 24 and npm. With nvm:

```sh
nvm use
npm ci
```

Installing dependencies enables the Git hooks. Pre-commit runs lint and tests.
The commit-message hook accepts a single line of at most 120 characters:

```text
feat: DEV-00000 add a tool
```

Allowed types are `feat`, `fix`, `doc`, and `chore`. The `DEV-` identifier has
exactly five digits and is assigned manually.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

These commands check the root configuration and run the corresponding
Turborepo task in each workspace that defines it.

## Layout

- `tools/<name>/`: independently versioned tools, each with a `package.json`
  and a `README.md`. Every tool README has the same sections in the same
  order: an intro with one diagram, **Setup**, **How to use**, and **Test
  locally**. List a new tool under its type in [Contents](#contents).
- `packages/<name>/`: shared packages added when needed.

Each workspace should provide `lint`, `typecheck`, `test`, and `build` scripts
as appropriate. Versions are managed independently and updated manually.

No license has been granted for this repository.
