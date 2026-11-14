export const pocketApi = 2;

const fail = message => { throw new Error(message); };
const number = (value, min, max) => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') fail('Complete the generation timeout field.');
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) fail(`Enter a whole number between ${min} and ${max}.`);
  return result;
};

export function draftFromSettings(settings) {
  const values = settings.values ?? {};
  return { endpoint: String(values.endpoint ?? ''), timeoutMinutes: String(values.timeoutMinutes ?? 30) };
}

export function settingsPatch(draft) {
  const endpoint = draft.endpoint.trim();
  let url;
  try { url = new URL(endpoint); } catch { fail('Enter a complete HTTP or HTTPS service URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Use an HTTP or HTTPS URL without credentials, a query, or a fragment.');
  if (endpoint.length > 4096) fail('The service URL is too long.');
  return { endpoint, timeoutMinutes: number(draft.timeoutMinutes, 1, 120) };
}

export default function setup(pocket) {
  const { html, useState, useEffect, useRef } = pocket;
  pocket.style('style.css');
  const inputStyle = { width: '100%', boxSizing: 'border-box', minHeight: '44px', fontSize: '16px', padding: '8px 10px', color: 'var(--text)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '8px' };
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', gap: '16px' };
  const labelStyle = { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 };
  const actions = { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' };
  const buttonStyle = { minHeight: '44px', padding: '8px 14px' };

  function Settings({ close }) {
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
    const [stale, setStale] = useState(false);
    const mounted = useRef(true), savingNow = useRef(false);
    const canSave = typeof pocket.saveSettings === 'function';
    async function load() {
      setLoading(true); setError('');
      try {
        const settings = await pocket.settings();
        if (!mounted.current) return;
        setDraft(draftFromSettings(settings)); setStale(false);
      } catch { if (mounted.current) setError('Settings could not be loaded. Check that the extension is enabled, then retry.'); }
      finally { if (mounted.current) setLoading(false); }
    }
    useEffect(() => {
      mounted.current = true;
      void load();
      const stop = typeof pocket.onSettings === 'function' ? pocket.onSettings(() => { if (mounted.current && !savingNow.current) setStale(true); }) : () => {};
      return () => { mounted.current = false; stop(); };
    }, []);
    const update = patch => { setDraft(before => ({ ...before, ...patch })); setNotice(''); setError(''); };
    function field(label, name, value, change, extra = {}) {
      return html`<label style=${labelStyle}><span>${label}</span><input name=${name} value=${value} onInput=${event => change(event.currentTarget.value)} style=${inputStyle} disabled=${saving} ...${extra} /></label>`;
    }
    async function save(event) {
      event.preventDefault();
      if (!canSave || savingNow.current || saving || stale) return;
      setError(''); setNotice('');
      let patch;
      try { patch = settingsPatch(draft); } catch (failure) { setError(failure.message); return; }
      savingNow.current = true; setSaving(true);
      try {
        await pocket.saveSettings(patch);
        const settings = await pocket.settings();
        if (mounted.current) { setDraft(draftFromSettings(settings)); setStale(false); setNotice('Settings saved. No restart is needed.'); }
      } catch { if (mounted.current) setError('Settings could not be saved. Reload to check the current values before retrying.'); }
      finally { savingNow.current = false; if (mounted.current) setSaving(false); }
    }
    if (loading) return html`<div role="status" style=${{ padding: '24px' }}>Loading Stable Fast 3D settings…</div>`;
    if (!draft) return html`<div style=${{ padding: '16px' }}><p class="error-box" role="alert">${error}</p><button class="button" style=${buttonStyle} onClick=${load}>Retry</button></div>`;
    return html`<form onSubmit=${save} style=${{ padding: '16px', width: '100%', maxWidth: '48rem', boxSizing: 'border-box', display: 'grid', gap: '20px' }}>
      <p class="muted" style=${{ margin: 0 }}>Point this module at the local Stable Fast 3D API. Finish active conversions before changing the service URL.</p>
      ${!canSave && html`<p class="error-box" role="alert">This Pi Pocket build cannot save from a dedicated settings sheet. Update Pi Pocket or use its inline Extensions settings.</p>`}
      ${stale && html`<p class="error-box" role="alert">Settings changed elsewhere. Reload to review the current values before saving.</p>`}
      <section aria-labelledby="sf3d-connection"><h3 id="sf3d-connection">Connection</h3>
        <div style=${grid}>
          ${field('Service URL', 'endpoint', draft.endpoint, endpoint => update({ endpoint }), { type: 'text', inputMode: 'url', required: true, placeholder: 'http://stable-fast-3d:8000', autoComplete: 'off', spellCheck: false, maxLength: 4096 })}
          ${field('Generation timeout (minutes)', 'timeoutMinutes', draft.timeoutMinutes, timeoutMinutes => update({ timeoutMinutes }), { type: 'number', step: 1, required: true })}
        </div>
        <p class="small muted">The URL must be reachable from the Pi Pocket server, not just your browser. Use HTTPS outside a trusted private network.</p>
      </section>
      <div style=${{ position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--card)', borderTop: '1px solid var(--line)', display: 'grid', gap: '8px' }}>
        ${error && html`<p class="error-box" role="alert" style=${{ margin: 0 }}>${error}</p>`}
        ${notice && html`<p role="status" style=${{ margin: 0, color: 'var(--ok)' }}>${notice}</p>`}
        <div style=${actions}>
          <button class="button primary" style=${buttonStyle} type="submit" disabled=${saving || !canSave || stale}>${saving ? 'Saving…' : 'Save settings'}</button>
          <button class="button" style=${buttonStyle} type="button" disabled=${saving} onClick=${() => { setNotice(''); void load(); }}>Reload saved settings</button>
          <button class="button" style=${buttonStyle} type="button" disabled=${saving} onClick=${close}>Close</button>
        </div>
      </div>
    </form>`;
  }
  pocket.sheet({ id: 'settings', title: 'Stable Fast 3D', wide: true, component: Settings });
  pocket.menu({ id: 'settings', label: 'Stable Fast 3D settings', sheet: 'settings' });
  pocket.launcher({ id: 'settings', label: 'Stable Fast 3D settings', detail: 'Service URL and generation timeout', keywords: ['3d', 'glb', 'mesh'], icon: 'cube', sheet: 'settings' });
}
