# matrix-js-sdk `version-support.ts` snapshot

- Captured at: `2026-04-06`
- Upstream repository: `https://github.com/matrix-org/matrix-js-sdk`
- Observed branch metadata (non-authoritative): `develop`
- Observed commit: `d02205652f23d3ea1a9433938a5e1eb5b6d74f5d`
- Commit-pinned source URL:
  `https://raw.githubusercontent.com/matrix-org/matrix-js-sdk/d02205652f23d3ea1a9433938a5e1eb5b6d74f5d/src/version-support.ts`

Relevant exported truth from the observed file:

```ts
export const SUPPORTED_MATRIX_VERSIONS = [
    "v1.1",
    "v1.2",
    "v1.3",
    "v1.4",
    "v1.5",
    "v1.6",
    "v1.7",
    "v1.8",
    "v1.9",
    "v1.10",
    "v1.11",
    "v1.12",
    "v1.13",
];
```

Interpretation captured for this repository:

- current official Matrix browser-client baseline still rejects homeservers that only advertise `v1.17`
- the compatibility floor used by `matrix-js-sdk` remains an intersection with `v1.1` through `v1.13`
- this snapshot is an observation input only; current project truth still lives in `spec/framework/`
