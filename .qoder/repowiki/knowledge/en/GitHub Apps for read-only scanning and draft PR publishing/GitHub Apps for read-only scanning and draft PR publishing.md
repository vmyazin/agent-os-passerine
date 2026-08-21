---
kind: external_dependency
name: GitHub Apps for read-only scanning and draft PR publishing
slug: github-apps
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Role
Two distinct GitHub App identities are required: a reader app (Contents: read) used to scan repositories and a publisher app (Contents + PR-write) used by the trusted publisher to create draft PRs. Both are bound per-repository via allowlists (`GITHUB_SELECTED_REPOSITORIES_JSON`, `GITHUB_READER_SELECTED_REPOSITORIES_JSON`).

### Auth protocol
- Reader: `GITHUB_READER_APP_ID` + `GITHUB_READER_PRIVATE_KEY`.
- Publisher: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
- Publication webhook signatures verified against rotating HMAC keys in `GITHUB_PUBLICATION_KEYS_JSON`.
- Login uses `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_ALLOWED_LOGIN` for operator auth.