// ── Smoke tests — validates core modules load without side-effects ──

describe('portal-service smoke', () => {
  it('config.ts should export valid configuration', async () => {
    const config = await import('../src/config.ts');
    expect(config).toBeTruthy();
  });

  it('constants.ts should export values', async () => {
    const constants = await import('../src/constants.ts');
    expect(constants).toBeTruthy();
  });
});

