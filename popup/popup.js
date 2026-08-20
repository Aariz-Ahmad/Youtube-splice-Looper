const SETTINGS_KEY = 'ytsl_settings';
const DEFAULTS = {
  fadeMs: 130,
  keys: { setStart: '[', setEnd: ']', toggleLoop: '\\', refine: 'Enter' },
};

const KEY_LABELS = { ' ': 'Space', Escape: 'Esc' };
function displayKey(key) {
  return KEY_LABELS[key] || key;
}

let settings = JSON.parse(JSON.stringify(DEFAULTS));
let recordingAction = null;

const fadeInput = document.getElementById('fadeMs');
const keybindBtns = document.querySelectorAll('.keybind-btn');
const hintEl = document.getElementById('keybindHint');
const resetBtn = document.getElementById('resetBtn');

function load() {
  chrome.storage.local.get([SETTINGS_KEY], (result) => {
    settings = result[SETTINGS_KEY] || JSON.parse(JSON.stringify(DEFAULTS));
    render();
  });
}

function save() {
  chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

function render() {
  fadeInput.value = settings.fadeMs;
  keybindBtns.forEach((btn) => {
    btn.textContent = displayKey(settings.keys[btn.dataset.action]);
  });
}

fadeInput.addEventListener('change', () => {
  let v = parseInt(fadeInput.value, 10);
  if (Number.isNaN(v)) v = DEFAULTS.fadeMs;
  v = Math.max(0, Math.min(500, v));
  settings.fadeMs = v;
  fadeInput.value = v;
  save();
});

keybindBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    recordingAction = btn.dataset.action;
    keybindBtns.forEach((b) => b.classList.remove('recording'));
    btn.classList.add('recording');
    btn.textContent = 'press a key\u2026';
    hintEl.textContent = 'Press any key, or Esc to cancel.';
  });
});

document.addEventListener('keydown', (e) => {
  if (!recordingAction) return;
  e.preventDefault();

  if (e.key === 'Escape') {
    recordingAction = null;
    render();
    hintEl.textContent = 'Click a keybind, then press any key.';
    return;
  }

  const conflict = Object.entries(settings.keys).find(
    ([action, key]) => action !== recordingAction && key === e.key
  );
  if (conflict) {
    hintEl.textContent = `"${displayKey(e.key)}" is already used for ${conflict[0]}. Choose another key.`;
    return;
  }

  settings.keys[recordingAction] = e.key;
  recordingAction = null;
  save();
  render();
  hintEl.textContent = 'Click a keybind, then press any key.';
});

resetBtn.addEventListener('click', () => {
  settings = JSON.parse(JSON.stringify(DEFAULTS));
  save();
  render();
});

load();
