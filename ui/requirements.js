const mac = /Mac/.test(navigator.userAgent);

const el = (tag, attrs = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), attrs);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const code = (text) => el('code', {}, text);
const link = (href) => el('a', { href, target: '_blank', rel: 'noopener' }, href);

const HINT_URLS = {
  git: 'https://git-scm.com/downloads',
  claude: 'https://docs.anthropic.com/en/docs/claude-code',
  codex: 'https://github.com/openai/codex',
};

const TOOLS = [
  ['git', 'git', () => ['Install it from ', link(HINT_URLS.git), ...(mac ? [' or run ', code('xcode-select --install')] : []), '.']],
  ['claude', 'Claude Code', () => ['Install it with ', code(mac ? 'curl -fsSL https://claude.ai/install.sh | bash' : 'irm https://claude.ai/install.ps1 | iex'),
    ` (${mac ? 'Terminal' : 'PowerShell'}, see `, link(HINT_URLS.claude), '), then run ', code('claude'), ' once and log in.']],
  ['codex', 'Codex', () => ['Install it with ', code('npm install -g @openai/codex'), ' (see ', link(HINT_URLS.codex), '), then run ', code('codex'), ' once and log in.']],
];

export function requirementsList() {
  const list = el('div', { className: 'k95-requirements' });
  const check = el('button', { type: 'button', className: 'k95-requirements-check', textContent: 'Check again' });
  const load = async () => {
    check.disabled = true;
    list.replaceChildren(el('p', {}, 'Checking...'));
    try {
      const r = await fetch('/api/requirements');
      if (!r.ok) throw new Error(`check failed (${r.status})`);
      const found = await r.json();
      list.replaceChildren(...TOOLS.map(([key, name, hint]) => {
        const f = found[key];
        return el('div', { className: 'k95-requirement' },
          el('div', { className: 'field-row' }, el('b', {}, name), ': ', f.found ? `found${f.version ? ` (${f.version})` : ''}` : 'missing'),
          f.found ? null : el('p', { className: 'k95-requirement-hint' }, ...hint()));
      }), el('p', {}, 'The board needs git and at least one of Claude Code or Codex. It installs none of them.'));
    } catch (e) {
      list.replaceChildren(el('p', {}, e.message));
    }
    check.disabled = false;
  };
  check.addEventListener('click', load);
  load();
  return [list, check];
}
