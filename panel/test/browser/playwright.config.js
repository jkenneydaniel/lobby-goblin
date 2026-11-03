import {defineConfig} from '@playwright/test';

export const scope = '/hosts/' + 'a'.repeat(32) + '/servers/' + 'b'.repeat(32);
// Keep fixed listeners below the default Linux ephemeral range used by the
// fixtures' port-0 controllers, so allocation cannot claim another listener.
export const origins = {
  factorio: 'http://127.0.0.1:31731',
  rust: 'http://127.0.0.1:31732',
  fleet: 'http://127.0.0.1:31733',
  arena: 'http://127.0.0.1:31736',
  application: 'http://127.0.0.1:31737',
  recoveryDesktop: 'http://127.0.0.1:31734',
  recoveryMobile: 'http://127.0.0.1:31735',
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const server = (file, url, env) => ({
  command: quote(process.execPath) + ' ../' + file,
  url,
  env: {
    ...env,
    DOCKER_SOCKET: '/nonexistent/lobby-goblin-browser-tests.sock',
  },
  reuseExistingServer: false,
  timeout: 30_000,
  gracefulShutdown: {signal: 'SIGTERM', timeout: 5000},
});

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  outputDir: '../../../output/playwright/results',
  reporter: [
    ['list'],
    [
      'html',
      {outputFolder: '../../../output/playwright/report', open: 'never'},
    ],
  ],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {name: 'desktop', use: {viewport: {width: 1440, height: 1000}}},
    {
      name: 'mobile',
      use: {
        viewport: {width: 390, height: 844},
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    server('service-app-ui-preview.js',origins.application,{APPLICATION_UI_PORT:'31737'}),
    server('arena-ui-preview.js',origins.arena,{ARENA_UI_PORT:'31736'}),
    server('ui-preview.js', origins.factorio + scope + '/', {
      UI_PREVIEW_PORT: '31731',
      UI_SERVER_SCOPE: scope,
      UI_CREATE_TEST: '1',
      UI_ONBOARDING_TEST: '1',
    }),
    server('rust-ui-preview.js', origins.rust, {RUST_UI_PORT: '31732'}),
    server('fleet-ui-preview.js', origins.fleet, {UI_PREVIEW_PORT: '31733'}),
    server('rust-ui-preview.js', origins.recoveryDesktop, {
      RUST_UI_PORT: '31734',
      UI_RECOVERY_TEST: '1',
    }),
    server('rust-ui-preview.js', origins.recoveryMobile, {
      RUST_UI_PORT: '31735',
      UI_RECOVERY_TEST: '1',
    }),
  ],
});
