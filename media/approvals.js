// Página do painel Aprovações. Tudo que vem do Claude entra como texto (textContent), nunca
// como HTML. Um cartão por pedido; cartões que continuam na lista não são refeitos, então o
// texto digitado em "Negar" não se perde quando chega outro pedido.
(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const cards = new Map();
  let offset = 0; // relógio da extensão menos o desta página

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const button = (label, cls, onClick, title) => {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  const ago = (at) => {
    const s = Math.max(0, Math.round((Date.now() + offset - at) / 1000));
    if (s < 60) return `há ${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  };
  const send = (msg) => vscode.postMessage(msg);

  function body(b) {
    if (!b) return null;
    if (b.kind === 'code') return el('pre', 'code', b.text);
    if (b.kind === 'text') return el('div', 'text', b.text);
    const diff = (d) => {
      const pre = el('pre', 'code diff');
      for (const line of String(d.old || '').split('\n')) pre.appendChild(el('span', 'del', `- ${line}\n`));
      for (const line of String(d.new || '').split('\n')) pre.appendChild(el('span', 'add', `+ ${line}\n`));
      return pre;
    };
    if (b.kind === 'diff') return diff(b);
    if (b.kind === 'diffs') {
      const box = el('div', 'diffs');
      for (const d of b.edits || []) box.appendChild(diff(d));
      return box;
    }
    return null;
  }

  function card(it) {
    const c = el('section', `card where-${it.where}`);
    c.dataset.id = it.id;

    const top = el('div', 'top');
    const where = it.where === 'here' ? 'Esta janela' : it.where === 'other' ? `Outra janela: ${it.windowName}` : 'Janela não identificada';
    top.appendChild(el('span', `badge ${it.where}`, where));
    const time = el('span', 'time', ago(it.at));
    time.dataset.at = it.at;
    top.appendChild(time);
    c.appendChild(top);

    c.appendChild(el('div', 'title', it.title || it.project || 'Conversa'));
    const ctx = [];
    if (it.title && it.project) ctx.push(it.project);
    if (it.prompt) ctx.push(`pedido: “${it.prompt}”`);
    if (ctx.length) c.appendChild(el('div', 'context', ctx.join(' · ')));

    const what = el('div', 'what');
    what.appendChild(el('strong', null, it.verb));
    if (it.target) what.appendChild(el('span', 'target', ` ${it.target}`));
    c.appendChild(what);
    const b = body(it.body);
    if (b) c.appendChild(b);

    if (it.said) {
      const d = el('details', 'said');
      d.appendChild(el('summary', null, 'O que o Claude disse antes'));
      d.appendChild(el('div', 'text', it.said));
      c.appendChild(d);
    }

    const actions = el('div', 'actions');
    const answer = (action, extra = {}) => {
      c.classList.add('sent');
      send({ type: 'answer', id: it.id, action, ...extra });
    };
    if (it.canAllow) {
      actions.appendChild(button(it.allowLabel, 'primary', () => answer('allow')));
      for (const s of it.suggestions) actions.appendChild(button(s.label, 'secondary', () => answer('always', { suggestion: s.i })));
    }
    const denyBox = el('div', 'deny hidden');
    if (it.canAllow) {
      actions.appendChild(button('Negar', 'secondary', () => {
        denyBox.classList.toggle('hidden');
        if (!denyBox.classList.contains('hidden')) input.focus();
      }));
      actions.appendChild(button('Parar', 'danger', () => answer('stop'), 'Nega e para o Claude nesta conversa'));
    } else {
      c.appendChild(el('div', 'note', 'Esta precisa ser respondida na aba da conversa.'));
    }
    if (it.canGo) actions.appendChild(button(it.where === 'here' ? 'Abrir a conversa' : 'Ir para a conversa', 'link', () => send({ type: 'go', id: it.id })));
    c.appendChild(actions);

    const input = el('textarea');
    input.rows = 2;
    input.placeholder = 'O que o Claude deve fazer no lugar (opcional)';
    const denyNow = () => answer('deny', { message: input.value });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        denyNow();
      }
    });
    denyBox.appendChild(input);
    const row = el('div', 'actions');
    row.appendChild(button('Negar', 'primary', denyNow));
    row.appendChild(button('Cancelar', 'link', () => denyBox.classList.add('hidden')));
    denyBox.appendChild(row);
    c.appendChild(denyBox);
    return c;
  }

  function render(state) {
    offset = state.now - Date.now();
    const ids = new Set(state.items.map((it) => it.id));
    for (const [id, c] of cards) {
      if (!ids.has(id)) {
        c.remove();
        cards.delete(id);
      }
    }
    for (const empty of list.querySelectorAll('.empty')) empty.remove();
    for (const it of state.items) {
      if (!cards.has(it.id)) cards.set(it.id, card(it));
      list.appendChild(cards.get(it.id)); // keeps the order, oldest first
    }
    if (!state.items.length) {
      const e = el('div', 'empty');
      if (state.enabled) {
        e.appendChild(el('p', null, 'Nenhum pedido esperando.'));
        e.appendChild(el('p', 'muted', 'Os pedidos de permissão de todas as conversas do Claude Code, em qualquer janela, aparecem aqui. Cada um diz de qual janela e conversa veio.'));
      } else {
        e.appendChild(el('p', null, 'Aprovações desligado.'));
        e.appendChild(button('Ligar', 'primary', () => send({ type: 'toggle' })));
      }
      list.appendChild(e);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') render(e.data);
  });
  setInterval(() => {
    for (const t of list.querySelectorAll('.time')) t.textContent = ago(Number(t.dataset.at));
  }, 1000);
  send({ type: 'ready' });
})();
