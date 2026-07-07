// ── Smoke tests — validates core modules load without side-effects ──

import { describe, it, expect } from "vitest";

describe('portal-service smoke', () => {
  it('config.ts should export valid configuration', async () => {
    const config = await import('../config.ts');
    expect(config).toBeTruthy();
  });

  it('constants.ts should export values', async () => {
    const constants = await import('../constants.ts');
    expect(constants).toBeTruthy();
  });
});


