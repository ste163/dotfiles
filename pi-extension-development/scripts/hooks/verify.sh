#!/usr/bin/env bash
# Automatic verification for the hooks extension (see .pi/hooks.json).
# Runs the mandatory checklist from AGENTS.md. A formatting failure is
# auto-fixed with a repo-wide oxfmt run and the checklist then re-runs, so
# formatting never needs a manual step. Typecheck, lint, and test failures
# are not auto-fixed; they still fail loudly for the agent to repair.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! npm run format:check; then
  npm run format
  echo "format:check failed - files auto-formatted, re-verifying"
fi

npm run typecheck
npm run lint
npm run format:check
npm test
