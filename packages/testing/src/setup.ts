// Test setup file for Vitest
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupGlobalTestEnvironment, teardownGlobalTestEnvironment } from './test-containers';

// Global test setup
beforeAll(async () => {
  console.log('Setting up global test environment...');
  await setupGlobalTestEnvironment();
  console.log('Global test environment setup complete');
});

afterAll(async () => {
  console.log('Tearing down global test environment...');
  await teardownGlobalTestEnvironment();
  console.log('Global test environment teardown complete');
});

// Increase timeout for integration tests
beforeEach(() => {
  // Set default timeout for each test
  vi.setConfig({ testTimeout: 30000 });
});

// Clean up after each test
afterEach(() => {
  // Clear any mocks
  vi.clearAllMocks();
});

// Global test utilities
declare global {
  var testUtils: any;
  var testEnvironment: any;
}

// Make test utilities available globally
beforeAll(async () => {
  const { TestUtils, getGlobalTestEnvironment } = await import('./test-containers');
  const testEnvironment = getGlobalTestEnvironment();
  const testUtils = new TestUtils(testEnvironment.getPool(), testEnvironment.getRedisClient());
  await testUtils.connect();
  
  global.testUtils = testUtils;
  global.testEnvironment = testEnvironment;
});

afterAll(async () => {
  if (global.testUtils) {
    await global.testUtils.disconnect();
  }
});
