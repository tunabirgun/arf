// Arf docs — theme toggle with persistence, and active-nav marking.
(function () {
  var KEY = 'arf-docs-theme';
  function apply(t) { document.documentElement.setAttribute('data-theme', t); }
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved) {
    apply(saved);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    apply('dark');
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeBtn');
    if (btn) btn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      var next = cur === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
    });
    // mark the current page in the nav
    var here = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.topbar nav a').forEach(function (a) {
      var href = a.getAttribute('href');
      if (href === here || (here === '' && href === 'index.html')) a.classList.add('on');
    });
  });
})();
