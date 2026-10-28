// Applies the persisted theme before first paint. MV3 CSP forbids inline
// scripts, so this ships as a standalone file loaded at the top of <body>.
// The localStorage key is a cache of the background preference; ThemeProvider
// reconciles it after boot. The dark background hex must match --qbit-canvas
// in src/ui/styles/global.less ([data-theme='dark']).
(function () {
  try {
    var stored = localStorage.getItem('themeMode');
    var mode = stored === 'light' || stored === 'dark' ? stored : 'system';
    var dark =
      mode === 'dark' ||
      (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (dark && document.body) {
      document.body.style.backgroundColor = '#0e1512';
    }
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
