# Agent instructions

## Keep engineering and validation bounded

- Treat the user's time, model spend, and infrastructure costs as constraints. Avoid overengineering and extended validation detours that add no useful delivery evidence.
- Before adding a test, harness, environment, review agent, or abstraction, identify the concrete unresolved requirement or risk and the decision its result will change. If there is no clear answer, do not add it.
- Use the smallest decisive check and existing tools or environments first. Do not build elaborate infrastructure to prove a narrow behavior.
- Once the relevant required checks pass, move toward delivery. Repeat or broaden validation only for changed code, an observed failure, or a specific unresolved acceptance requirement.
- Distinguish application defects from test-harness, fixture, and local-environment failures. Do not repeatedly rebuild testing infrastructure or count harness debugging as product progress.
- If validation setup starts dominating the work, stop expanding it, preserve the evidence, and report the remaining coverage plainly so the user can regroup. Never hide failures or claim untested behavior passed.
- Stop dependent checks when their prerequisite fails; do not burn time on cascading timeouts. Do not launch redundant reviews or agents without a distinct unresolved question.
- Keep status reports concrete: what works, what is broken, what is unverified, and what actually remains. Do not substitute a growing checklist or more activity for completion.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
