# Agent guidance

<!-- project-guide:base start (0.7.0) -->
## Working in this repo

This repo follows the project-guide standard, version 0.7.0
(https://github.com/rschlek/project-guide). This block is replaced when the
standard updates; put project-specific guidance in the section below it.

- Read `README.md` and `project.yaml` first: what this is, who it is for,
  and where related things live.
- Before changing `project.yaml`, `README.md`, `AGENTS.md`, `CLAUDE.md`, or
  the repo's layout, read `docs/project-conventions.md` and keep to it.
- Make one change for one purpose, and run the checks this repo documents
  before proposing it.
- Commit only the files you changed, by path. Never commit credentials,
  tokens, or data extracts.
- If `project.yaml` says `visibility: public`, anyone can read this repo:
  write no person, employer, team, host, or machine names into it.
- If it says `visibility: internal`, everyone in the organization that
  hosts this repo can read it: the organization's own names are fine,
  other people's personal details are not.
- Documents are for someone who opens this repo without the user's memory.
  If `project.yaml` says `shared: true` or sets `visibility`, write the plan
  for a piece of work and the decisions a reader needs into the repo: plans
  in `docs/plan/`, decisions in `docs/decisions.md`. Otherwise write such
  documents only when asked.
- Never track progress in a document: no checkboxes, status lines, or live
  handoff files. Read `docs/project-conventions.md` before writing or moving
  anything under `docs/`, and leave existing documents as they are.
- In a repo other people use, changes go in through its review process,
  not straight to the main branch.
- Keep work in progress in a worktree under `.claude/worktrees/`, one
  session per worktree, and push its branch before leaving it.
- Do not move or rename the repo, and keep `project.yaml` true when the
  project changes.
<!-- project-guide:base end -->
