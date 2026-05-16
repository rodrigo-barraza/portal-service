// ── Smoke tests — validates core modules load without side-effects ──

describe('portal-service smoke', () => {
  it('config.js should export valid configuration', async () => {
    const config = await import('../src/config.js');
    expect(config).toBeTruthy();
  });

  it('constants.js should export values', async () => {
    const constants = await import('../src/constants.js');
    expect(constants).toBeTruthy();
  });
});
