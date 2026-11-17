// Entry: nothing heavy here. The 3D scene (and Three.js) is a separate chunk,
// loaded only after the page has painted and only where it can run well.

const hero = document.getElementById('hero');
const stage = document.getElementById('stage');
const tools = document.getElementById('hero-tools');

function canRun3D() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (navigator.connection && navigator.connection.saveData) return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    // Software rasterisers (no GPU acceleration) would run the ocean on the CPU: keep the poster.
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

// The poster is the hero until the visitor shows interest (moves, touches, scrolls, types)
// or the page has sat idle for a few seconds. The 3D scene then loads and takes over, so
// its start-up work never competes with the first paint and first interaction.
function whenWanted(fn) {
  const events = ['pointerdown', 'pointermove', 'touchstart', 'wheel', 'keydown', 'scroll'];
  const opts = { passive: true };
  let timer = 0;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    events.forEach((e) => window.removeEventListener(e, go, opts));
    if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 1200 });
    else setTimeout(fn, 60);
  };
  events.forEach((e) => window.addEventListener(e, go, opts));
  const arm = () => (timer = setTimeout(go, 4000));
  if (document.readyState === 'complete') arm();
  else window.addEventListener('load', arm, { once: true });
}

if (canRun3D()) {
  whenWanted(async () => {
    try {
      const { startScene } = await import('./scene/index.js');
      const scene = await startScene({ container: stage, hero });
      hero.classList.add('is-live');
      tools.hidden = false;
      bindTimeOfDay(scene);
    } catch (err) {
      console.warn('[hero] 3D disabled:', err);
    }
  });
}

function bindTimeOfDay(scene) {
  const buttons = tools.querySelectorAll('[data-tod]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
      scene.setTimeOfDay(btn.dataset.tod);
    });
  });
}

// ---------- contact form ----------
// No server yet: the request opens the visitor's email app, pre-filled. The destination
// address comes from the form's data-email attribute (to be set with the real one).
const form = document.getElementById('contact-form');
const statusEl = document.getElementById('form-status');
if (form) {
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const nome = String(data.get('nome') || '').trim();
    const contatto = String(data.get('contatto') || '').trim();
    if (!nome || !contatto) {
      statusEl.textContent = "Indiquez votre nom et un moyen de vous joindre, pour que nous puissions vous répondre.";
      (nome ? form.elements.contatto : form.elements.nome).focus();
      return;
    }
    const to = form.dataset.email;
    if (!to) {
      statusEl.textContent = "Formulaire pas encore relié : il manque l'adresse e-mail de destination.";
      return;
    }
    const righe = [
      'Demande : ' + data.get('interesse'),
      'Nom : ' + nome,
      'Contact : ' + contatto,
      data.get('data') ? 'Date souhaitée : ' + data.get('data') : '',
      '',
      String(data.get('messaggio') || ''),
    ].filter((r, i) => r !== '' || i === 4);
    const subject = 'Demande depuis le site : ' + String(data.get('interesse')).toLowerCase();
    window.location.href = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(righe.join('\n'));
    statusEl.textContent = "Votre messagerie s'ouvre avec la demande déjà remplie.";
  });
}

// "Parlons-en" in the sales section pre-selects "Achat" in the form.
document.querySelectorAll('[data-interest="vendita"]').forEach((el) => {
  el.addEventListener('click', () => {
    const r = form && form.querySelector('input[name="interesse"][value="Achat"]');
    if (r) r.checked = true;
  });
});

const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
