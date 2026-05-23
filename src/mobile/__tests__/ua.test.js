import { describe, it, expect } from 'vitest';
import { isMobileUA, shouldRedirectToMobile } from '../ua.js';

describe('isMobileUA', () => {
  const mobileSamples = [
    // iPhone Safari
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    // Android Chrome
    'Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    // iPod
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    // Mobile Firefox
    'Mozilla/5.0 (Android 12; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
  ];

  const desktopSamples = [
    // macOS Safari
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    // Windows Chrome
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Linux Firefox
    'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    // iPad — deliberately treated as desktop
    'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    // Modern iPadOS (reports as Mac)
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    // Empty UA
    '',
  ];

  mobileSamples.forEach((ua) => {
    it(`treats as mobile: ${ua.slice(0, 40)}…`, () => {
      expect(isMobileUA(ua)).toBe(true);
    });
  });

  desktopSamples.forEach((ua) => {
    it(`treats as desktop: ${ua.slice(0, 40) || '(empty)'}…`, () => {
      expect(isMobileUA(ua)).toBe(false);
    });
  });
});

describe('shouldRedirectToMobile', () => {
  const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const desktopUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

  function stubSession(value) {
    const store = value == null ? new Map() : new Map([['forceDesktop', value]]);
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    };
  }

  it('mobile UA at root → redirects to m/', () => {
    const result = shouldRedirectToMobile({
      pathname: '/',
      search: '',
      sessionStorage: stubSession(null),
      userAgent: mobileUA,
    });
    expect(result.redirect).toBe(true);
    expect(result.target).toBe('m/');
  });

  it('mobile UA at sub-path root → redirects to m/ (relative)', () => {
    const result = shouldRedirectToMobile({
      pathname: '/tle_orbit_visualizer/',
      search: '',
      sessionStorage: stubSession(null),
      userAgent: mobileUA,
    });
    expect(result.redirect).toBe(true);
    expect(result.target).toBe('m/');
  });

  it('mobile UA but already at /m/ → no redirect', () => {
    const result = shouldRedirectToMobile({
      pathname: '/m/',
      search: '',
      sessionStorage: stubSession(null),
      userAgent: mobileUA,
    });
    expect(result.redirect).toBe(false);
  });

  it('mobile UA but already at /m/index.html → no redirect', () => {
    const result = shouldRedirectToMobile({
      pathname: '/tle_orbit_visualizer/m/index.html',
      search: '',
      sessionStorage: stubSession(null),
      userAgent: mobileUA,
    });
    expect(result.redirect).toBe(false);
  });

  it('mobile UA but forceDesktop in session → no redirect', () => {
    const result = shouldRedirectToMobile({
      pathname: '/',
      search: '',
      sessionStorage: stubSession('1'),
      userAgent: mobileUA,
    });
    expect(result.redirect).toBe(false);
  });

  it('desktop UA → no redirect', () => {
    const result = shouldRedirectToMobile({
      pathname: '/',
      search: '',
      sessionStorage: stubSession(null),
      userAgent: desktopUA,
    });
    expect(result.redirect).toBe(false);
  });

  it('preserves query string in redirect target', () => {
    const result = shouldRedirectToMobile({
      pathname: '/',
      search: '?foo=bar&baz=qux',
      sessionStorage: stubSession(null),
      userAgent: mobileUA,
    });
    expect(result.redirect).toBe(true);
    expect(result.target).toBe('m/?foo=bar&baz=qux');
  });
});
