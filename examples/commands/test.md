---
description: Run the test suite and fix failures
argument-hint: "[test name or path]"
---
Run the project's tests $ARGUMENTS and fix any failures you find.

Current git status for context:
!`git status --short`

Work until the tests pass. If a failure is caused by something outside the scope
of the code under test, stop and explain it instead of changing unrelated code.
