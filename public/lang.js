/**
 * lang.js — shared bilingual logic for all NB News Digest pages
 *
 * Each page must have:
 *   - #btn-en and #btn-fr toggle buttons
 *   - Elements with class .lang-en and .lang-fr for toggled content
 *   - Optionally #footer-en and #footer-fr for footer lines
 *
 * Lang preference is read from localStorage and falls back to
 * the browser's navigator.language. The user's explicit toggle
 * choice is always saved back to localStorage.
 */

(function () {
  // ── Detect preferred language ──────────────────────────────────────
  function getPreferredLang() {
    try {
      const saved = localStorage.getItem('nb-lang');
      if (saved === 'en' || saved === 'fr') return saved;
    } catch (e) {}
    return (navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }

  // ── Apply language to the page ─────────────────────────────────────
  function setLang(lang) {
    // Show/hide content blocks
    document.querySelectorAll('.lang-en').forEach(el => {
      el.hidden = (lang !== 'en');
    });
    document.querySelectorAll('.lang-fr').forEach(el => {
      el.hidden = (lang !== 'fr');
    });

    // Update toggle button states
    const btnEn = document.getElementById('btn-en');
    const btnFr = document.getElementById('btn-fr');
    if (btnEn) btnEn.setAttribute('aria-pressed', String(lang === 'en'));
    if (btnFr) btnFr.setAttribute('aria-pressed', String(lang === 'fr'));

    // Update <html lang> for screen readers
    document.documentElement.lang = lang;

    // Persist choice
    try { localStorage.setItem('nb-lang', lang); } catch (e) {}
  }

  // ── Expose globally so onclick handlers can call it ────────────────
  window.setLang = setLang;

  // ── Apply on page load ─────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    setLang(getPreferredLang());
  });
})();