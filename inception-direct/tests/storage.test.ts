// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, cleanKey, forgetKey, loadKey, maskKey, sanitiseSettings, saveKey } from '../src/app/storage';

describe('settings', () => {
  it('fills defaults and rejects junk', () => {
    const s = sanitiseSettings({
      model: 'mercury 2 <script>' as string,
      effort: 'extreme' as never,
      lengthLimit: 1234,
      readingSize: 99,
      diffusing: 'yes' as never,
    });
    expect(s.model).toBe(DEFAULT_SETTINGS.model);
    expect(s.effort).toBe('medium');
    expect(s.lengthLimit).toBe(16384);
    expect(s.readingSize).toBe(24);
    expect(s.diffusing).toBe(false);
  });

  it('keeps valid values', () => {
    const s = sanitiseSettings({ model: 'mercury-2', effort: 'instant', lengthLimit: 65536, diffusing: true, reasoningSummary: false, followUps: false });
    expect(s).toMatchObject({ model: 'mercury-2', effort: 'instant', lengthLimit: 65536, diffusing: true, reasoningSummary: false, followUps: false });
  });
});

describe('API key storage (this browser only)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('cleans pasted keys', () => {
    expect(cleanKey('  Bearer sk_live_abc123  ')).toBe('sk_live_abc123');
    expect(cleanKey('"sk_abc"')).toBe('sk_abc');
    expect(cleanKey('sk_ab c\n')).toBe('sk_abc');
    expect(cleanKey('   ')).toBe('');
  });

  it('masks keys without revealing more than 8 characters', () => {
    expect(maskKey('sk_live_abcdef123456')).toBe('sk_l…3456');
    expect(maskKey('short')).toBe('•••••');
  });

  it('remembers on this device (localStorage) or for this tab only (sessionStorage)', () => {
    saveKey('sk_device', true);
    expect(loadKey()).toEqual({ key: 'sk_device', remember: true });
    expect(sessionStorage.length).toBe(0);

    saveKey('sk_tab', false);
    expect(loadKey()).toEqual({ key: 'sk_tab', remember: false });
    expect(localStorage.length).toBe(0); // switching modes removes the other copy
  });

  it('forgets everywhere', () => {
    saveKey('sk_device', true);
    forgetKey();
    expect(loadKey()).toBeNull();
  });
});
