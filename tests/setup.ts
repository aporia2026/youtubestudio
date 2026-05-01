// Test-environment setup. Loaded once per Vitest worker before any test file.
//
// We deliberately keep this thin: the migration runner and crypto module are
// tested in isolation with mocks, so PR #1 does not require a real database.
// PR #2 (which introduces real schema migrations) will add an integration
// harness that spins up a transactional connection against a test database.

// Crypto helpers refuse to run without a key. Provide one for the test process.
if (!process.env.ENCRYPTION_KEY && !process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = 'test-secret-do-not-use-in-prod-' + 'x'.repeat(32);
}
