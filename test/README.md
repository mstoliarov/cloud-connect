# Tests

Run all tests:
```bash
node --test 'test/*.test.js'
```

Note: on Git Bash (Windows), pass the glob in quotes. MSYS rewrites a bare `test/` into a Windows path that Node treats as a module specifier.

Zero external dependencies — uses Node 18+ built-in `node:test` runner.
