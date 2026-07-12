---
name: coding-standards
description: TypeScript coding standards and testing conventions for this project. Always load when writing or editing code or tests in pi-extension-development.
---

# Coding Standards

## TypeScript Style

- **Arrow functions over function declarations/expressions.** Prefer
  `const foo = (...) => {}` everywhere a real function isn't required.
- **Follow SRP.** Each function/module does one thing; split instead of
  growing a function to cover multiple responsibilities.
- **Prefer ternaries** over if/else for simple conditional expressions, and
  **prefer built-ins** (`.map`, `.reduce`, `.filter`, etc.) over manual loops.
- **Use `reduce` over `Set`** for dedup/aggregation-style logic.
- **Fail fast.** Validate/guard early and throw/return immediately on bad
  state rather than letting it propagate.
- **Never disable a lint rule to silence it** — fix the underlying issue
  the rule is flagging instead.
- **Don't fear large refactors.** 100% test coverage is the safety net;
  restructure code freely when it improves readability/testability.
- **Optimize for readability and testability over brevity.** More verbose
  but clearer code is preferred over clever/compact code.

## Testing

- **Black box only.** Test the extension's observable behavior (given inputs
  → given output/side effects), never internal implementation details.
  Don't test private helpers directly if they're not part of the extension's
  public surface — exercise them through the same entry point pi calls.
- **Always mock pi itself.** Never depend on a real pi runtime. Inject fake
  pi APIs/objects the extension receives (context, tool handlers, etc.) as
  plain in-memory fakes.
- **Always in-memory.** No real disk I/O, no `process.chdir`, no temp
  directories, no real network calls. Anything external is dependency-
  injected (see `PlanModeDeps` pattern) and swapped for an in-memory fake
  in tests.
- **Fewer tests, more expectations.** When the input data is the same,
  don't write a separate test per assertion — combine into one test with
  multiple expectations against that single run/output.
- **Naming: short but precise.** Test names should say what input/condition
  and what outcome, without padding.
- **Order: failure scenarios first, then success.** Within a spec file/
  describe block, list the failure/edge cases before the happy path.
- **Order tests to mirror the code's actual branching logic** (e.g. same
  order as the `if`/`else`/`switch` branches appear in the function under
  test), not an arbitrary or alphabetical order.
