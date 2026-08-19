const ssoBtn = document.getElementById('ssoBtn');
const ssoLabel = document.getElementById('ssoLabel');
const divider = document.getElementById('divider');
const form = document.getElementById('loginForm');
const errorEl = document.getElementById('error');
const submitBtn = document.getElementById('submitBtn');
const passwordInput = document.getElementById('password');
const toggleVis = document.getElementById('toggleVis');

document.getElementById('copyYear').textContent = `© ${new Date().getFullYear()} Convoy. All rights reserved.`;

fetch('/api/auth/config')
  .then((res) => res.json())
  .then((cfg) => {
    if (!cfg.oidc) return;
    ssoLabel.textContent = cfg.oidc.label;
    ssoBtn.classList.add('show');
    if (cfg.passwordEnabled) divider.classList.add('show');
  })
  .catch(() => {});

ssoBtn.addEventListener('click', () => {
  location.href = '/api/auth/oidc/start';
});

toggleVis.addEventListener('click', () => {
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  toggleVis.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.remove('show');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';
  try {
    const password = passwordInput.value;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      location.href = '/';
      return;
    }
    errorEl.classList.add('show');
  } catch {
    errorEl.classList.add('show');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
  }
});
