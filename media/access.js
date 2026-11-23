// Página Acesso. Uma tela por vez: escolher (sem login ou grupo), a URL de login do grupo, o
// login com os campos que a API pediu, e o que está valendo. A tela só é refeita quando muda; o que foi digitado não se perde quando
// chega uma resposta. Tudo que vem da API entra como texto (textContent), nunca como HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const page = document.getElementById('page');
  const send = (msg) => vscode.postMessage(msg);
  let shown = '';
  let refs = {};

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const button = (label, cls, onClick) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const field = (label, type, autocomplete) => {
    const box = el('label', 'field');
    box.appendChild(el('span', null, label));
    const input = el('input');
    input.type = type;
    input.autocomplete = autocomplete;
    input.spellcheck = false;
    box.appendChild(input);
    return { box, input };
  };
  const onEnter = (input, fn) =>
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        fn();
      }
    });

  const screens = {
    escolher() {
      const box = el('div');
      box.appendChild(el('h2', null, 'Como você quer usar o Claude Switcher?'));
      const free = button('', 'choice', () => send({ type: 'livre' }));
      free.appendChild(el('strong', null, 'Entrar sem login'));
      free.appendChild(el('span', 'muted', 'Tudo liberado neste computador, inclusive a configuração.'));
      const group = button('', 'choice', () => send({ type: 'grupo' }));
      group.appendChild(el('strong', null, 'Entrar em um grupo'));
      group.appendChild(el('span', 'muted', 'A sua organização confere o login e define o que cada nível pode usar.'));
      box.append(free, group);
      return { box, buttons: [free, group] };
    },

    url() {
      const box = el('div');
      box.appendChild(el('h2', null, 'Entrar em um grupo'));
      const url = field('URL de login do grupo', 'url', 'url');
      url.input.placeholder = 'https://…';
      box.appendChild(url.box);
      box.appendChild(el('p', 'muted', 'Peça a URL de login para quem administra o grupo na sua organização.'));
      const go = () => send({ type: 'url', url: url.input.value });
      onEnter(url.input, go);
      const next = button('Continuar', 'primary', go);
      const back = button('Voltar', 'link', () => send({ type: 'cancelar' }));
      const actions = el('div', 'actions');
      actions.append(next, back);
      box.appendChild(actions);
      return { box, buttons: [next, back], inputs: [url.input], focus: url.input };
    },

    login(s) {
      const box = el('div');
      box.appendChild(el('h2', null, `Entrar no grupo ${s.nome}`));
      const dest = el('p', 'dest');
      dest.append('Os seus dados vão para ', el('strong', null, s.host));
      box.appendChild(dest);
      if (s.reason) box.appendChild(el('p', 'note', s.reason));
      // Os campos que a API pediu; o primeiro que não é senha é o "usuário" para o preenchimento.
      const firstUser = s.campos.find((c) => c.tipo !== 'password');
      const fields = s.campos.map((c) => ({ c, f: field(c.rotulo, c.tipo, c.tipo === 'password' ? 'current-password' : c === firstUser ? 'username' : 'off') }));
      for (const { f } of fields) box.appendChild(f.box);
      const go = () => {
        const valores = {};
        for (const { c, f } of fields) valores[c.nome] = f.input.value;
        send({ type: 'entrar', valores });
        for (const { c, f } of fields) if (c.tipo === 'password') f.input.value = '';
      };
      fields.forEach(({ f }, i) => onEnter(f.input, () => (i + 1 < fields.length ? fields[i + 1].f.input.focus() : go())));
      const enter = button('Entrar', 'primary', go);
      const back = s.back === 'sair' ? button('Sair do grupo', 'link', () => send({ type: 'sair' })) : button('Voltar', 'link', () => send({ type: 'voltar' }));
      const actions = el('div', 'actions');
      actions.append(enter, back);
      box.appendChild(actions);
      return { box, buttons: [enter, back], inputs: fields.map(({ f }) => f.input), focus: fields[0].f.input };
    },

    livre() {
      const box = el('div');
      box.appendChild(el('h2', null, 'Sem login'));
      box.appendChild(el('p', null, 'Você usa o Claude Switcher sem login: tudo liberado neste computador, inclusive a configuração.'));
      const group = button('Entrar em um grupo', 'secondary', () => send({ type: 'grupo' }));
      const actions = el('div', 'actions');
      actions.appendChild(group);
      box.appendChild(actions);
      return { box, buttons: [group] };
    },

    grupo(s) {
      const box = el('div');
      box.appendChild(el('h2', null, `Grupo ${s.nome}`));
      const who = [s.usuario, s.nivel && `nível ${s.nivel}`].filter(Boolean).join(' · ');
      if (who) box.appendChild(el('p', null, who));
      const when = [s.host, s.until && `sessão até ${s.until}`].filter(Boolean).join(' · ');
      box.appendChild(el('p', 'muted', when));
      box.appendChild(el('h3', null, 'O que o seu nível permite'));
      const list = el('ul', 'perms');
      for (const p of s.permissions) {
        const li = el('li', p.on ? 'on' : 'off');
        li.appendChild(el('span', 'mark', p.on ? '✓' : '✕'));
        li.appendChild(el('span', null, p.label));
        list.appendChild(li);
      }
      box.appendChild(list);
      if (s.checked) box.appendChild(el('p', 'muted', `Conferido com o grupo em ${s.checked}.`));
      const buttons = [];
      if (s.checkable) buttons.push(button('Conferir agora', 'secondary', () => send({ type: 'conferir' })));
      buttons.push(button('Sair do grupo', 'link', () => send({ type: 'sair' })));
      const actions = el('div', 'actions');
      actions.append(...buttons);
      box.appendChild(actions);
      return { box, buttons };
    },
  };

  function render(s) {
    const key = JSON.stringify([s.screen, s.nome, s.host, s.campos, s.reason, s.usuario, s.nivel, s.until, s.checked, s.permissions]);
    if (key !== shown && screens[s.screen]) {
      shown = key;
      const built = screens[s.screen](s);
      refs = { ...built, error: el('p', 'error hidden') };
      refs.error.setAttribute('role', 'alert');
      page.replaceChildren(built.box, refs.error);
      if (built.focus) built.focus.focus();
    }
    for (const b of refs.buttons || []) b.disabled = !!s.busy;
    for (const i of refs.inputs || []) i.disabled = !!s.busy;
    refs.error.textContent = s.error || '';
    refs.error.classList.toggle('hidden', !s.error);
    page.classList.toggle('busy', !!s.busy);
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') render(e.data);
  });
  send({ type: 'ready' });
})();
