#!/usr/bin/env bash
# Automatic verification for the hooks extension (see .pi/hooks.json).
# Runs the mandatory checklist from AGENTS.md. format:check is used instead
# of format so the hook never rewrites files mid-session.
set -euo pipefail

cd "$(dirname "$0")/../.."

npm run typecheck
npm run lint
npm run format:check
npm test
