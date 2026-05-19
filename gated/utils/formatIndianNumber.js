/* Indian number formatter — display-layer only, no logic dependency.
 *
 * Why: STARBHAI's audience is Indian retail. Western 3-3-3 comma grouping
 * (`1,234,567`) is alien; Indian retail expects 2-2-3 lakhs/crores grouping
 * (`12,34,567`) and short forms `12.35L` / `1.23Cr`. The platform previously
 * mixed both styles depending on the call-site. This module is the single
 * source of truth.
 *
 * Exposed on window for vanilla-JS callers:
 *   window.IndianNumber.toFull(1234567)       → "12,34,567"
 *   window.IndianNumber.toShort(1234567)      → "12.35L"
 *   window.IndianNumber.toCurrencyFull(1234567)  → "₹12,34,567"
 *   window.IndianNumber.toCurrencyShort(1234567) → "₹12.35L"
 *   window.IndianNumber.toSigned(125.50)      → "+₹125.50"   (badge use)
 *   window.IndianNumber.toPct(0.0823)         → "+8.23%"
 */
(function () {
  'use strict';

  const inrFormatter = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  });
  const inrFormatterTwo = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  function isFiniteNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  function coerce(value) {
    // Strict guard: null / undefined / "" should NOT become 0 via Number().
    if (value == null || value === '') return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function toFull(value, options = {}) {
    const n = coerce(value);
    if (!isFiniteNum(n)) return '—';
    const fmt = options.twoDecimals ? inrFormatterTwo : inrFormatter;
    return fmt.format(n);
  }

  function toShort(value, options = {}) {
    const n = coerce(value);
    if (!isFiniteNum(n)) return '—';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    let body;
    if (abs >= 1e7) {
      body = (abs / 1e7).toFixed(abs >= 1e9 ? 0 : 2) + 'Cr';
    } else if (abs >= 1e5) {
      body = (abs / 1e5).toFixed(abs >= 1e7 ? 0 : 2) + 'L';
    } else if (abs >= 1e3) {
      body = (abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1) + 'K';
    } else {
      body = inrFormatter.format(abs);
    }
    return sign + body;
  }

  function toCurrencyFull(value, options) {
    const formatted = toFull(value, options);
    if (formatted === '—') return formatted;
    return '₹' + formatted;
  }

  function toCurrencyShort(value, options) {
    const formatted = toShort(value, options);
    if (formatted === '—') return formatted;
    if (formatted.startsWith('-')) {
      return '-₹' + formatted.slice(1);
    }
    return '₹' + formatted;
  }

  function toSigned(value, options = {}) {
    const n = coerce(value);
    if (!isFiniteNum(n)) return '—';
    const body = options.short ? toShort(Math.abs(n), options) : toFull(Math.abs(n), options);
    const prefix = options.currency ? '₹' : '';
    if (n > 0) return '+' + prefix + body;
    if (n < 0) return '-' + prefix + body;
    return prefix + body;
  }

  function toPct(value, options = {}) {
    const n = coerce(value);
    if (!isFiniteNum(n)) return '—';
    const places = options.places != null ? options.places : 2;
    const scaled = options.alreadyPct ? n : n * 100;
    const formatted = scaled.toFixed(places);
    if (options.signed && scaled > 0) return '+' + formatted + '%';
    return formatted + '%';
  }

  window.IndianNumber = {
    toFull,
    toShort,
    toCurrencyFull,
    toCurrencyShort,
    toSigned,
    toPct,
  };
})();
