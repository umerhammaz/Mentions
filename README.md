# ZeroCommit Ship Log

This orphan branch holds ZeroCommit Studio deployment receipts.
It contains no application code and is managed automatically.

Layout:
- `r/<sha>-<ts>.json` — one immutable receipt per deploy
- `sessions/<sid>.json` — client session metadata (pushed once per session)

Do not commit code here. Receipts are append-only; the sync engine only adds new files.
Discovery: the fixed branch name `zerocommit-shiplog` is the contract — no config file needed.
