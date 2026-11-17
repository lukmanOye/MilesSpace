// /js/theme-init.js
// Loaded synchronously from <head>, before any paint.
// Applies the saved (or preferred) theme by adding `dark` to <html>.
// CSP-safe: external file, no inline execution.
(function () {
  'use strict';
  try {
    var t = localStorage.getItem('ms-theme');
    var dark;
    if (t === 'dark')      dark = true;
    else if (t === 'light') dark = false;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) dark = true;
    else                    dark = false;

    if (dark) {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.style.colorScheme = 'light';
    }
  } catch (e) { /* localStorage blocked; leave default */ }
})();