## Description
<!-- Provide a brief description of the changes in this PR -->

## Type of Change
<!-- Please delete options that are not relevant -->
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Performance improvement
- [ ] Code refactoring

## Checklist
<!-- Please check all that apply -->
- [ ] I have read the [CONTRIBUTING.md](../CONTRIBUTING.md) guidelines
- [ ] **Every commit is signed off** (`git commit -s`) per the [DCO](../DCO) — the `dco` CI check enforces this
- [ ] My code follows the code style of this project and does not use the `any` type
- [ ] I have performed a self-review of my own code
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] `pnpm test:unit` passes locally with my changes
- [ ] I have run `pnpm typecheck` and `pnpm lint` locally
- [ ] I have tested the Electron app locally with `pnpm dev`

## Critical Areas Modified
<!-- Check if you modified any of these critical areas -->
- [ ] Entity-model writes (must funnel through `TaskChangeRouter` / `ReviewItemRouter` / `ArtifactRouter` chokepoints — no direct table UPDATEs)
- [ ] IPC contract or tRPC router shapes (keep request/response `T` parity — see CLAUDE.md)
- [ ] Database migrations (`main/src/database/migrations/`)
- [ ] Workflow/agent prompt bodies or the dual-substrate seam

## Screenshots (if applicable)
<!-- Add screenshots to help explain your changes -->

## Additional Notes
<!-- Add any additional notes or context about the PR here -->