const SUPABASE_URL = 'https://nmecbbmlvrzeqazapijf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-zL5W-Pf5WMHAZZCONw4_g_RNbjhE5g'; // clé publique : la sécurité vient des règles de la base
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString('fr-FR') : '-');
const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };
const badge = (s) => `<span class="badge ${esc(s)}">${{ pending: 'En attente', active: 'Actif', suspended: 'Suspendu' }[s] || esc(s)}</span>`;
const btn = (label, act, data, cls = '') => `<button class="sm ${cls}" data-act="${act}" data-d="${esc(JSON.stringify(data))}">${label}</button>`;
const searchBox = '<input id="search" class="search" placeholder="Rechercher…">';

function table(cols, rows) {
  if (!rows.length) return '<p class="empty">Rien à afficher.</p>';
  return '<table><thead><tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
}

// Boîte de saisie (prompt() n'existe pas dans Electron)
function ask(title, fields) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>` +
      fields.map((f, i) => `<label>${esc(f.label)}<input id="f${i}" type="${f.type || 'text'}"></label>`).join('') +
      '<div class="row"><button value="cancel" class="ghost">Annuler</button><button value="ok">Valider</button></div></form>';
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? fields.map((_, i) => d.querySelector('#f' + i).value.trim()) : null);
    d.showModal();
  });
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) { alert('Erreur : ' + error.message); throw error; }
  return data;
}

// ---------- Actions (boutons des tableaux) ----------
const acts = {
  async shopStatus({ id, v }) {
    if (!confirm(v === 'active' ? 'Activer ce commerce ?' : 'Suspendre ce commerce ?')) throw 0;
    await rpc('admin_set_shop_status', { p_shop: id, p_status: v });
  },
  async undo({ id }) {
    if (!confirm('Annuler ce scan ? Les points seront retirés.')) throw 0;
    await rpc('admin_undo_scan', { p_scan: id });
  },
  async adjust({ shop, client, name }) {
    const r = await ask(`Ajuster le solde de ${name}`, [{ label: 'Points à ajouter (ex. 20) ou retirer (ex. -10)', type: 'number' }, { label: 'Motif (obligatoire)' }]);
    if (!r) throw 0;
    const n = parseInt(r[0], 10);
    if (!n) { alert('Nombre invalide'); throw 0; }
    await rpc('admin_adjust_balance', { p_shop: shop, p_client: client, p_delta: n, p_reason: r[1] });
  },
  async resolve({ id }) { await rpc('admin_resolve_alert', { p_id: id }); },
};

// ---------- Écrans ----------
const views = {
  async dash() {
    const cnt = async (t, f) => {
      let r = sb.from(t).select('*', { count: 'exact', head: true });
      if (f) r = f(r);
      const { count, error } = await r;
      if (error) throw error;
      return count ?? 0;
    };
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const [clients, shops, pending, scans, alerts] = await Promise.all([
      cnt('profiles'), cnt('shops'), cnt('shops', (r) => r.eq('status', 'pending')),
      cnt('scans', (r) => r.gte('created_at', t0.toISOString()).is('undone_at', null)),
      cnt('fraud_alerts', (r) => r.is('resolved_at', null)),
    ]);
    const card = (n, l, cls = '') => `<div class="card ${cls}"><b>${n}</b><span>${l}</span></div>`;
    return `<h2>Tableau de bord</h2><div class="cards">${card(clients, 'Utilisateurs')}${card(shops, 'Commerces')}` +
      `${card(pending, 'Commerces à valider', pending ? 'warn' : '')}${card(scans, "Scans aujourd'hui")}${card(alerts, 'Alertes fraude', alerts ? 'bad' : '')}</div>`;
  },

  async shops() {
    const rows = await q(sb.from('shops').select('*').order('created_at', { ascending: false }));
    return `<h2>Commerces</h2>${searchBox}` + table(['Nom', 'Adresse', 'Téléphone', 'Statut', 'Pts/visite', 'Seuil', 'Créé le', 'Actions'],
      rows.map((s) => [esc(s.name), esc(s.address), esc(s.phone), badge(s.status), s.points_per_visit, s.reward_threshold, fmt(s.created_at),
        s.status === 'active' ? btn('Suspendre', 'shopStatus', { id: s.id, v: 'suspended' }, 'danger')
          : s.status === 'pending' ? btn('Valider', 'shopStatus', { id: s.id, v: 'active' }) + btn('Refuser', 'shopStatus', { id: s.id, v: 'suspended' }, 'danger')
          : btn('Réactiver', 'shopStatus', { id: s.id, v: 'active' })]));
  },

  async clients() {
    const rows = await q(sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(1000));
    return `<h2>Clients et utilisateurs</h2>${searchBox}` + table(['Pseudo', 'Téléphone', 'Rôle', 'Inscrit le'],
      rows.map((p) => [esc(p.display_name), esc(p.phone), p.is_admin ? 'Administrateur' : 'Utilisateur', fmt(p.created_at)]));
  },

  async balances() {
    const rows = await q(sb.from('balances').select('points, last_scan_at, client_id, shop_id, profiles(display_name), shops(name)').order('points', { ascending: false }).limit(1000));
    return `<h2>Soldes de points</h2>${searchBox}` + table(['Client', 'Commerce', 'Points', 'Dernière visite', 'Action'],
      rows.map((b) => [esc(b.profiles?.display_name), esc(b.shops?.name), b.points, fmt(b.last_scan_at),
        btn('Ajuster', 'adjust', { shop: b.shop_id, client: b.client_id, name: b.profiles?.display_name || '' })]));
  },

  async scans() {
    const rows = await q(sb.from('scans').select('id, points, created_at, undone_at, client:profiles!scans_client_id_fkey(display_name), shops(name)').order('created_at', { ascending: false }).limit(200));
    return `<h2>Derniers scans</h2>${searchBox}` + table(['Date', 'Client', 'Commerce', 'Points', 'Statut', 'Action'],
      rows.map((s) => [fmt(s.created_at), esc(s.client?.display_name), esc(s.shops?.name), '+' + s.points,
        s.undone_at ? 'Annulé' : 'Valide', s.undone_at ? '' : btn('Annuler', 'undo', { id: s.id }, 'danger')]));
  },

  async alerts() {
    const rows = await q(sb.from('fraud_alerts').select('*, profiles(display_name), shops(name)').order('created_at', { ascending: false }).limit(200));
    const kinds = { multi_shop: 'Deux commerces en moins de 5 min' };
    return '<h2>Alertes de fraude</h2>' + table(['Date', 'Type', 'Client', 'Commerce', 'Statut', 'Action'],
      rows.map((a) => [fmt(a.created_at), esc(kinds[a.kind] || a.kind), esc(a.profiles?.display_name), esc(a.shops?.name),
        a.resolved_at ? 'Traitée' : '<b>À traiter</b>', a.resolved_at ? '' : btn('Marquer traitée', 'resolve', { id: a.id })]));
  },

  async notify() {
    return '<h2>Notification à tous les utilisateurs</h2><div class="form"><label>Titre<input id="nt"></label>' +
      '<label>Message<textarea id="nb" rows="3"></textarea></label><button id="send">Envoyer à tous</button></div>';
  },

  async journal() {
    const rows = await q(sb.from('admin_log').select('*, profiles(display_name)').order('created_at', { ascending: false }).limit(300));
    return '<h2>Journal des actions</h2>' + table(['Date', 'Admin', 'Action', 'Détails'],
      rows.map((l) => [fmt(l.created_at), esc(l.profiles?.display_name), esc(l.action), `<code>${esc(JSON.stringify(l.details))}</code>`]));
  },
};

function bind(tab) {
  const s = $('#search');
  if (s) s.oninput = () => {
    const t = s.value.toLowerCase();
    document.querySelectorAll('tbody tr').forEach((tr) => { tr.hidden = !tr.textContent.toLowerCase().includes(t); });
  };
  if (tab === 'notify') $('#send').onclick = async () => {
    const t = $('#nt').value.trim(), b = $('#nb').value.trim();
    if (!t) return alert('Le titre est obligatoire.');
    if (!confirm('Envoyer cette notification à TOUS les utilisateurs ?')) return;
    try { const n = await rpc('admin_broadcast', { p_title: t, p_body: b }); alert(n + ' notifications envoyées.'); $('#nt').value = ''; $('#nb').value = ''; } catch (_) {}
  };
}

let current = 'dash';
async function go(t) {
  current = t;
  document.querySelectorAll('nav [data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  const main = $('#main');
  main.innerHTML = '<p class="empty">Chargement…</p>';
  try { main.innerHTML = await views[t](); bind(t); }
  catch (e) { main.innerHTML = `<p class="err">Erreur : ${esc(e.message)}</p><p class="empty">Avez-vous exécuté admin_patch.sql dans Supabase ?</p>`; }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-t]');
  if (t) return go(t.dataset.t);
  const b = e.target.closest('[data-act]');
  if (!b) return;
  try { await acts[b.dataset.act](JSON.parse(b.dataset.d || '{}')); await go(current); } catch (_) {}
});

// ---------- Connexion ----------
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $('#login').hidden = false; $('#app').hidden = true; return; }
  const { data: p } = await sb.from('profiles').select('is_admin').eq('id', session.user.id).maybeSingle();
  if (!p?.is_admin) {
    await sb.auth.signOut();
    $('#lerr').textContent = "Ce compte n'est pas administrateur.";
    $('#login').hidden = false; $('#app').hidden = true; return;
  }
  $('#login').hidden = true; $('#app').hidden = false;
  go('dash');
}

$('#lf').onsubmit = async (e) => {
  e.preventDefault();
  $('#lerr').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
  if (error) { $('#lerr').textContent = 'E-mail ou mot de passe incorrect.'; return; }
  start();
};
$('#out').onclick = async () => { await sb.auth.signOut(); start(); };
start();
