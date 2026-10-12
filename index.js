'use strict';

// GOAT Betclic - Railway.
// Une seule réplique du service.
// Aucun classement n'est publié automatiquement.

const game = (() => {
  const { randomUUID } = require('node:crypto');

  const ZONE = 'Europe/Paris';
  const id = () => randomUUID().replaceAll('-', '').slice(0, 16);

  class UserError extends Error {}

  const need = (condition, text) => {
    if (!condition) throw new UserError(text);
  };

  const parisParts = ms => Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value])
  );

  function parisDate(ms) {
    const p = parisParts(ms);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function parisInput(ms) {
    const p = parisParts(ms);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function formatTime(ms) {
    const p = parisParts(ms);
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
  }

  function dateKey(value) {
    need(
      /^\d{4}-\d{2}-\d{2}$/.test(value || ''),
      'Date attendue : AAAA-MM-JJ.'
    );

    const ms = Date.parse(`${value}T12:00:00Z`);

    need(
      Number.isFinite(ms) &&
      new Date(ms).toISOString().slice(0, 10) === value,
      'Date invalide.'
    );

    return value;
  }

  function shiftDate(value, days) {
    const ms =
      Date.parse(`${dateKey(value)}T12:00:00Z`) +
      days * 86400000;

    return new Date(ms).toISOString().slice(0, 10);
  }

  function weekKey(value) {
    const date = dateKey(value);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();

    return shiftDate(date, -(weekday === 0 ? 6 : weekday - 1));
  }

  function parseTime(value) {
    const text = value.trim();

    if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
      dateKey(text.slice(0, 10));

      const ms = Date.parse(text);
      need(Number.isFinite(ms), 'Date/heure ISO invalide.');

      return ms;
    }

    need(
      /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(text),
      'Date/heure attendue : AAAA-MM-JJ HH:mm, heure de Paris.'
    );

    dateKey(text.slice(0, 10));

    const utc = Date.parse(text.replace(' ', 'T') + ':00Z');
    const candidates = [];

    for (let offset = -180; offset <= 180; offset += 30) {
      const ms = utc + offset * 60000;

      if (parisInput(ms) === text) candidates.push(ms);
    }

    need(
      candidates.length > 0,
      'Cette heure n’existe pas au changement d’heure.'
    );

    need(
      candidates.length === 1,
      'Heure ambiguë. Utilise le format ISO avec décalage, par exemple 2026-10-25T02:30:00+02:00.'
    );

    return candidates[0];
  }

  function nowParis(ms = Date.now()) {
    return {
      toISODate: () => parisDate(ms),
      toFormat: () => {
        const p = parisParts(ms);
        return `${p.hour}:${p.minute}`;
      },
      minus: ({ days }) => nowParis(
        parseTime(`${shiftDate(parisDate(ms), -days)} 12:00`)
      ),
    };
  }

  function imageURL(value) {
    const url = value?.trim() || '';
    if (!url) return '';

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      throw new UserError('Lien image invalide.');
    }

    need(
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password,
      'Utilise un lien image HTTPS public.'
    );

    need(url.length <= 1000, 'Lien image trop long.');

    return url;
  }

  function odd(value) {
    const n = Number(String(value).replace(',', '.'));

    need(
      Number.isFinite(n) && n >= 1 && n <= 10000,
      'La cote doit être un nombre entre 1 et 10 000.'
    );

    return n;
  }

  function clean(value, max, name) {
    const s = String(value || '')
      .trim()
      .replace(/[\u2014\u2013]/g, '-');

    need(
      s.length > 0 && s.length <= max,
      `${name} : entre 1 et ${max} caractères.`
    );

    return s;
  }

  function initialState(config = {}) {
    return {
      schema: 1,
      config,
      days: {},
      users: {},
      resetArchives: [],
      audit: [],
    };
  }

  function getDay(state, dayId) {
    const day = state.days[dayId];
    need(day, 'Cette journée n’existe plus.');
    return day;
  }

  function getMatch(day, matchId) {
    const m = day.matches.find(x => x.id === matchId);
    need(m, 'Ce match n’existe plus.');
    return m;
  }

  const open = (m, now) =>
    m.result === null && now < m.lockAt;

  function createDay(state, input, now = Date.now()) {
    const date = dateKey(input.date);

    need(
      !Object.values(state.days).some(d => d.date === date),
      'Une journée existe déjà à cette date. Modifie-la pour ajouter des matchs.'
    );

    const publishAt = parseTime(input.publish);

    need(
      publishAt > now,
      'Choisis une publication dans le futur. Tu pourras publier immédiatement depuis le panneau.'
    );

    const day = {
      id: id(),
      date,
      week: weekKey(date),
      title: clean(
        input.title || 'GOAT BETCLIC | NBA',
        200,
        'Titre'
      ),
      description: (input.description || '')
        .trim()
        .replace(/[\u2014\u2013]/g, '-')
        .slice(0, 1500),
      image: imageURL(input.image),
      publishAt,
      status: 'draft',
      matches: [],
      votes: {},
      drafts: {},
      post: null,
      dirty: false,
      version: 1,
      createdAt: now,
    };

    state.days[day.id] = day;
    return day;
  }

  function editDay(day, input, now = Date.now()) {
    // La date sportive reste fixe pour préserver les semaines.
    day.title = clean(input.title, 200, 'Titre');

    day.description = (input.description || '')
      .trim()
      .replace(/[\u2014\u2013]/g, '-')
      .slice(0, 1500);

    day.image = imageURL(input.image);

    const at = parseTime(input.publish);

    if (day.status !== 'published') {
      need(at > now, 'Publication attendue dans le futur.');
    }

    day.publishAt = at;
    day.version++;
    day.dirty = true;
  }

  function matchInput(input) {
    const home = clean(input.home, 70, 'Équipe A');
    const away = clean(input.away, 70, 'Équipe B');

    need(
      home.toLowerCase() !== away.toLowerCase(),
      'Les deux équipes doivent être différentes.'
    );

    return {
      home,
      away,
      homeOdds: odd(input.homeOdds),
      awayOdds: odd(input.awayOdds),
      startAt: parseTime(input.start),
      image: imageURL(input.image),
    };
  }

  function saveMatch(day, input, matchId, now = Date.now()) {
    const data = matchInput(input);

    if (!matchId) {
      need(
        data.startAt > now,
        'Un nouveau match doit commencer dans le futur.'
      );

      const m = {
        id: id(),
        ...data,
        lockAt: data.startAt,
        result: null,
        revision: 1,
      };

      day.matches.push(m);
      day.version++;
      day.dirty = true;

      return m;
    }

    const m = getMatch(day, matchId);

    const teamChange =
      m.home !== data.home || m.away !== data.away;

    const hasVotes = Object.values(day.votes)
      .some(v => v.picks[m.id]);

    need(
      !teamChange || !hasVotes,
      'Des pronostics existent pour ces équipes. Invalide d’abord le match depuis le panneau : les membres devront le rejouer.'
    );

    if (teamChange) {
      m.revision++;
      m.result = null;
    }

    Object.assign(m, data);

    // Ne pas rouvrir une échéance déjà publiée.
    m.lockAt = day.status === 'published'
      ? Math.min(m.lockAt, data.startAt)
      : data.startAt;

    day.version++;
    day.dirty = true;

    return m;
  }

  function invalidate(day, matchId) {
    const m = getMatch(day, matchId);

    for (const v of [
      ...Object.values(day.votes),
      ...Object.values(day.drafts),
    ]) {
      delete v.picks[m.id];

      if (v.boost === m.id) v.boost = null;
    }

    m.result = null;
    m.revision++;
    day.version++;
    day.dirty = true;
  }

  function schedule(day, now = Date.now()) {
    need(
      day.matches.length,
      'Ajoute au moins un match avant de programmer.'
    );

    need(
      day.status !== 'published',
      'Cette journée est déjà publiée. Les modifications restent possibles.'
    );

    need(
      day.matches.some(m => open(m, now)),
      'Tous les matchs sont déjà fermés.'
    );

    need(
      day.matches.every(m => day.publishAt < m.lockAt),
      'La publication doit précéder chaque début de match.'
    );

    day.status = 'scheduled';
  }

  function draftFor(day, uid) {
    if (!day.drafts[uid]) {
      day.drafts[uid] = {
        ...structuredClone(
          day.votes[uid] || { picks: {}, boost: null }
        ),
        version: 0,
      };
    }

    return day.drafts[uid];
  }

  function draftPick(
    day,
    uid,
    mid,
    side,
    revision,
    now = Date.now()
  ) {
    need(
      day.status === 'published',
      'Cette journée n’est pas ouverte.'
    );

    const m = getMatch(day, mid);

    need(
      open(m, now),
      'Ce match est fermé. Tes pronostics déjà validés sont conservés.'
    );

    need(
      m.revision === revision,
      'Le match a été modifié. Rouvre ta grille avant de choisir.'
    );

    need(
      ['home', 'away'].includes(side),
      'Choix invalide.'
    );

    const d = draftFor(day, uid);

    d.picks[mid] = { side, revision };
    d.version = (d.version || 0) + 1;
  }

  function draftBoost(day, uid, mid, now = Date.now()) {
    const m = getMatch(day, mid);
    const d = draftFor(day, uid);
    const v = day.votes[uid];

    need(open(m, now), 'Ce match est fermé.');

    need(
      d.picks[mid]?.revision === m.revision,
      'Choisis une équipe sur ce match avant de le booster.'
    );

    const oldBoost = v?.boost || d.boost;

    if (oldBoost && oldBoost !== mid) {
      need(
        open(getMatch(day, oldBoost), now),
        'Ton boost est déjà verrouillé sur un match commencé.'
      );
    }

    d.boost = d.boost === mid ? null : mid;
    d.version = (d.version || 0) + 1;
  }

  function commit(day, uid, name, now = Date.now()) {
    need(
      day.status === 'published',
      'Cette journée n’est pas ouverte.'
    );

    const draft = draftFor(day, uid);

    const vote = structuredClone(
      day.votes[uid] || { picks: {}, boost: null }
    );

    let skipped = 0;

    for (const m of day.matches) {
      const p = draft.picks[m.id];
      if (!p) continue;

      if (open(m, now) && p.revision === m.revision) {
        vote.picks[m.id] = structuredClone(p);
      } else if (
        !vote.picks[m.id] ||
        vote.picks[m.id].side !== p.side ||
        vote.picks[m.id].revision !== p.revision
      ) {
        skipped++;
      }
    }

    const old = vote.boost
      ? getMatch(day, vote.boost)
      : null;

    if (!old || open(old, now)) {
      const next = draft.boost
        ? getMatch(day, draft.boost)
        : null;

      if (!next) {
        vote.boost = null;
      } else if (
        open(next, now) &&
        vote.picks[next.id]?.revision === next.revision
      ) {
        vote.boost = next.id;
      } else if (vote.boost !== next.id) {
        skipped++;
      }
    }

    need(
      Object.keys(vote.picks).length,
      'Aucun pronostic ouvert à valider.'
    );

    vote.name = name;
    vote.updatedAt = now;

    day.votes[uid] = vote;
    day.drafts[uid] = structuredClone(vote);

    return {
      count: Object.keys(vote.picks).length,
      skipped,
      boost: vote.boost,
    };
  }

  function setResult(day, mid, result, now = Date.now()) {
    const m = getMatch(day, mid);

    need(
      ['home', 'away', 'void', null].includes(result),
      'Résultat invalide.'
    );

    need(
      result === null ||
      result === 'void' ||
      now >= m.startAt,
      'Le match n’a pas encore commencé.'
    );

    m.result = result;
    day.version++;
    day.dirty = true;
  }

  function scoreDay(day) {
    return Object.entries(day.votes).map(([uid, vote]) => {
      let points = 0;
      let wins = 0;
      let boostedWins = 0;
      let picks = 0;

      for (const m of day.matches) {
        const p = vote.picks[m.id];

        if (!p || p.revision !== m.revision) continue;

        picks++;

        if (m.result === p.side) {
          wins++;
          points += vote.boost === m.id ? 4 : 2;

          if (vote.boost === m.id) boostedWins++;
        }
      }

      return {
        uid,
        name: vote.name || uid,
        points,
        wins,
        boostedWins,
        picks,
      };
    });
  }

  function ranking(state, scope) {
    const map = new Map();

    for (const day of Object.values(state.days)) {
      const included = scope.date
        ? day.date === scope.date
        : day.week === scope.week;

      if (!included) continue;

      for (const row of scoreDay(day)) {
        const old = map.get(row.uid) || {
          ...row,
          points: 0,
          wins: 0,
          boostedWins: 0,
          picks: 0,
        };

        for (const key of [
          'points',
          'wins',
          'boostedWins',
          'picks',
        ]) {
          old[key] += row[key];
        }

        old.name = row.name;
        map.set(row.uid, old);
      }
    }

    const rows = [...map.values()].sort((a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      b.boostedWins - a.boostedWins ||
      a.uid.localeCompare(b.uid)
    );

    rows.forEach((r, i) => {
      const prev = rows[i - 1];

      const tied = prev &&
        prev.points === r.points &&
        prev.wins === r.wins &&
        prev.boostedWins === r.boostedWins;

      r.rank = tied ? prev.rank : i + 1;
    });

    return rows;
  }

  function resetWeek(state, week, now = Date.now()) {
    need(
      dateKey(week) === weekKey(week),
      'Indique le lundi de la semaine à réinitialiser.'
    );

    const days = Object.values(state.days)
      .filter(d => d.week === week);

    state.resetArchives.push({
      at: now,
      week,
      days: structuredClone(days),
    });

    for (const d of days) {
      d.votes = {};
      d.drafts = {};
    }
  }

  function audit(state, uid, action, details) {
    state.audit.push({
      at: Date.now(),
      uid,
      action,
      details,
    });

    if (state.audit.length > 2000) {
      state.audit.splice(0, state.audit.length - 2000);
    }
  }

  return {
    ZONE,
    parisDate,
    parisInput,
    formatTime,
    UserError,
    need,
    id,
    nowParis,
    dateKey,
    weekKey,
    parseTime,
    imageURL,
    odd,
    clean,
    initialState,
    getDay,
    getMatch,
    open,
    createDay,
    editDay,
    saveMatch,
    invalidate,
    schedule,
    draftFor,
    draftPick,
    draftBoost,
    commit,
    setResult,
    scoreDay,
    ranking,
    resetWeek,
    audit,
  };
})();

const ui = (() => {
  const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    escapeMarkdown,
  } = require('discord.js');

  const G = game;

  const footer =
    'GOAT Betclic | 2 pts par bon choix • Boost x2 • Heure de Paris';

  const safe = value => escapeMarkdown(String(value))
    .replaceAll('@', '@\u200b');

  const formatOdd = n => Number(n).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const time = ms => G.formatTime(ms);

  const dateLabel = date =>
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: G.ZONE,
      weekday: 'long',
      day: '2-digit',
      month: 'long',
    }).format(new Date(date + 'T12:00:00Z'));

  const row = (...components) => new ActionRowBuilder()
    .addComponents(components.filter(Boolean));

  const button = (
    custom,
    label,
    style = ButtonStyle.Secondary,
    disabled = false
  ) => new ButtonBuilder()
    .setCustomId(custom)
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled);

  function embed(state, title) {
    const color = /^#[a-f\d]{6}$/i.test(
      state.config.color || ''
    )
      ? state.config.color
      : '#E31B23';

    const e = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setFooter({ text: footer });

    if (state.config.logo) {
      e.setThumbnail(state.config.logo);
    }

    return e;
  }

  function daily(state, day, now = Date.now()) {
    const active = day.matches
      .filter(m => G.open(m, now)).length;

    const settled = day.matches
      .filter(m => m.result !== null).length;

    const e = embed(state, day.title)
      .setDescription([
        `**🏀 ${dateLabel(day.date)}**`,
        day.description
          ? safe(day.description)
          : 'Choisis les équipes gagnantes et tente de prendre la tête du classement !',
        '',
        '**Comment jouer ?**',
        '1. Ouvre ta grille et choisis une équipe par match.',
        '2. Place ton **boost x2 sur un seul match de la journée**.',
        '3. Vérifie le récapitulatif et clique sur **Valider ma grille**.',
        '',
        '**Bon pronostic : 2 points. Bon pronostic boosté : 4 points.**',
        'Tu peux modifier tes choix jusqu’au début de chaque match. Les cotes sont indicatives pour le jeu et ne multiplient pas les points.',
      ].join('\n'))
      .addFields(
        {
          name: '📋 Matchs',
          value: `${day.matches.length}`,
          inline: true,
        },
        {
          name: '🔓 Encore ouverts',
          value: `${active}`,
          inline: true,
        },
        {
          name: '✅ Résultats saisis',
          value: `${settled}/${day.matches.length}`,
          inline: true,
        }
      );

    if (day.image) e.setImage(day.image);

    e.setFooter({
      text: `${footer} | Journée ${day.id}`,
    });

    return {
      embeds: [e],
      components: [
        row(
          button(
            `play:${day.id}:0`,
            '🏀 Jouer / Modifier',
            ButtonStyle.Danger,
            active === 0
          ),
          button(
            `summary:${day.id}:0`,
            '📋 Ma grille'
          ),
          button(
            `rank:d:${day.date}:0`,
            '📊 Classement du jour'
          ),
          button(
            `rank:w:${day.week}:0`,
            '🏆 Classement semaine'
          )
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }

  function matchCard(
    state,
    day,
    uid,
    index = 0,
    now = Date.now()
  ) {
    if (!day.matches.length) {
      return {
        content: 'Aucun match disponible.',
        embeds: [],
        components: [],
      };
    }

    index = Math.max(
      0,
      Math.min(Number(index) || 0, day.matches.length - 1)
    );

    const m = day.matches[index];
    const d = G.draftFor(day, uid);
    const v = day.votes[uid];
    const unlocked = G.open(m, now);

    const pick = unlocked
      ? d.picks[m.id]
      : v?.picks[m.id];

    const boost = unlocked ? d.boost : v?.boost;

    const e = embed(state, `🏀 ${m.home} vs ${m.away}`)
      .setDescription([
        `**Match ${index + 1}/${day.matches.length} | ${dateLabel(day.date)}**`,
        `⏰ Début : **${time(m.startAt)}**`,
        `🔒 Clôture : **${time(m.lockAt)}**`,
        '',
        `**${safe(m.home)}** : cote **${formatOdd(m.homeOdds)}**`,
        `**${safe(m.away)}** : cote **${formatOdd(m.awayOdds)}**`,
        '',
        pick?.revision === m.revision
          ? `Ton choix : **${safe(
            pick.side === 'home' ? m.home : m.away
          )}**${boost === m.id ? ' ⚡ Boost x2' : ''}`
          : 'Ton choix : **pas encore sélectionné**',
        unlocked
          ? '\n⚠️ Tes modifications seront enregistrées après **Valider ma grille** dans le récapitulatif.'
          : '\n🔒 Match fermé. Seuls les pronostics déjà validés comptent.',
        m.result === 'void'
          ? 'Match annulé : aucun point attribué.'
          : ['home', 'away'].includes(m.result)
            ? `Résultat : **${safe(
              m.result === 'home' ? m.home : m.away
            )}**`
            : '',
      ].filter(Boolean).join('\n'));

    if (m.image || day.image) {
      e.setImage(m.image || day.image);
    }

    return {
      content: '',
      embeds: [e],
      components: [
        row(
          button(
            `pick:${day.id}:${m.id}:home:${m.revision}:${index}`,
            m.home,
            pick?.side === 'home'
              ? ButtonStyle.Success
              : ButtonStyle.Primary,
            !unlocked
          ),
          button(
            `pick:${day.id}:${m.id}:away:${m.revision}:${index}`,
            m.away,
            pick?.side === 'away'
              ? ButtonStyle.Success
              : ButtonStyle.Primary,
            !unlocked
          )
        ),
        row(
          button(
            `boost:${day.id}:${m.id}:${index}`,
            boost === m.id
              ? '⚡ Retirer le boost'
              : '⚡ Booster ce match',
            ButtonStyle.Secondary,
            !unlocked
          ),
          button(
            `play:${day.id}:${index - 1}`,
            '← Précédent',
            ButtonStyle.Secondary,
            index === 0
          ),
          button(
            `play:${day.id}:${index + 1}`,
            'Suivant →',
            ButtonStyle.Secondary,
            index === day.matches.length - 1
          ),
          button(
            `summary:${day.id}:0`,
            '📋 Récapitulatif',
            ButtonStyle.Danger
          )
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }

  function summary(
    state,
    day,
    uid,
    page = 0,
    now = Date.now()
  ) {
    const d = G.draftFor(day, uid);
    const vote = day.votes[uid];

    const pageCount = Math.max(
      1,
      Math.ceil(day.matches.length / 10)
    );

    page = Math.max(
      0,
      Math.min(Number(page) || 0, pageCount - 1)
    );

    const lines = day.matches
      .slice(page * 10, page * 10 + 10)
      .map(m => {
        const p = G.open(m, now)
          ? d.picks[m.id]
          : vote?.picks[m.id];

        const boosted = (
          G.open(m, now) ? d.boost : vote?.boost
        ) === m.id;

        return (
          `**${safe(m.home)} / ${safe(m.away)}**\n` +
          `${G.open(m, now) ? '🔓' : '🔒'} ` +
          `${
            p?.revision === m.revision
              ? safe(p.side === 'home' ? m.home : m.away)
              : 'Aucun choix'
          }${boosted ? ' ⚡ x2' : ''}`
        );
      });

    const selected = day.matches.filter(m => (
      G.open(m, now)
        ? d.picks[m.id]
        : vote?.picks[m.id]
    )?.revision === m.revision).length;

    const e = embed(state, '📋 Vérifie ta grille')
      .setDescription([
        `**${dateLabel(day.date)} | ${selected}/${day.matches.length} matchs sélectionnés**`,
        '',
        ...lines,
        '',
        'Tu peux valider une grille partielle et compléter les matchs encore ouverts plus tard.',
        '**Les matchs commencés conservent uniquement tes choix déjà validés.**',
        `\nPage ${page + 1}/${pageCount}`,
      ].join('\n'));

    return {
      content: '',
      embeds: [e],
      components: [
        row(
          button(
            `confirm:${day.id}:${day.version}:${d.version || 0}`,
            '✅ Valider ma grille',
            ButtonStyle.Success
          ),
          button(
            `play:${day.id}:0`,
            '✏️ Modifier'
          ),
          button(
            `summary:${day.id}:${page - 1}`,
            '←',
            ButtonStyle.Secondary,
            page === 0
          ),
          button(
            `summary:${day.id}:${page + 1}`,
            '→',
            ButtonStyle.Secondary,
            page === pageCount - 1
          ),
          button(
            `discard:${day.id}`,
            'Annuler les modifications'
          )
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }

  function leaderboard(state, scope, page = 0) {
    const rows = G.ranking(state, scope);

    const pageCount = Math.max(
      1,
      Math.ceil(rows.length / 15)
    );

    page = Math.max(
      0,
      Math.min(Number(page) || 0, pageCount - 1)
    );

    const days = Object.values(state.days).filter(d =>
      scope.date
        ? d.date === scope.date
        : d.week === scope.week
    );

    const pending = days
      .flatMap(d => d.matches)
      .filter(m => m.result === null)
      .length;

    const label = scope.date
      ? `du ${scope.date}`
      : `de la semaine du ${scope.week}`;

    const description = rows
      .slice(page * 15, page * 15 + 15)
      .map(r =>
        `**${r.rank}.** <@${r.uid}> | **${r.points} pts** | ${r.wins} bons choix`
      )
      .join('\n');

    const e = embed(
      state,
      `🏆 GOAT Betclic | Classement ${label}`
    )
      .setDescription(
        description ||
        'Aucun pronostic validé pour cette période.'
      )
      .addFields(
        {
          name: pending
            ? '⏳ Classement provisoire'
            : '✅ Résultats disponibles',
          value: pending
            ? `${pending} résultat(s) encore à renseigner.`
            : 'Tous les résultats des matchs enregistrés sont saisis.',
        },
        {
          name: 'Égalités',
          value: 'Points, puis bons pronostics, puis boosts gagnants. Si tout est identique, les membres restent ex æquo.',
        }
      )
      .setFooter({
        text: `${footer} | Page ${page + 1}/${pageCount}`,
      });

    return {
      embeds: [e],
      components: [
        row(
          button(
            `rank:${scope.date ? 'd' : 'w'}:${scope.date || scope.week}:${page - 1}`,
            '←',
            ButtonStyle.Secondary,
            page === 0
          ),
          button(
            `rank:${scope.date ? 'd' : 'w'}:${scope.date || scope.week}:${page + 1}`,
            '→',
            ButtonStyle.Secondary,
            page === pageCount - 1
          )
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }

  function adminDay(state, day, index = 0) {
    index = Math.max(
      0,
      Math.min(
        Number(index) || 0,
        Math.max(0, day.matches.length - 1)
      )
    );

    const m = day.matches[index];

    const e = embed(state, `⚙️ ${day.title}`)
      .setDescription([
        `**ID journée :** \`${day.id}\``,
        `**Date sportive :** ${day.date} | **Semaine :** ${day.week}`,
        `**Publication Paris :** ${time(day.publishAt)}`,
        `**Statut :** ${day.status}`,
        `**Matchs :** ${day.matches.length} | **Participants :** ${Object.keys(day.votes).length}`,
        '',
        m
          ? (
            `**Match ${index + 1}/${day.matches.length}**\n` +
            `\`${m.id}\`\n` +
            `${safe(m.home)} (${formatOdd(m.homeOdds)}) / ` +
            `${safe(m.away)} (${formatOdd(m.awayOdds)})\n` +
            `Début ${time(m.startAt)} | Clôture ${time(m.lockAt)}\n` +
            `Résultat : ${m.result || 'en attente'}`
          )
          : 'Ajoute ton premier match.',
        '',
        'Les horaires saisis sont en heure de Paris. Une modification d’horaire ne rouvre pas un match déjà publié.',
      ].join('\n'));

    return {
      content: '',
      embeds: [e],
      components: [
        row(
          button(
            `admin:editday:${day.id}`,
            '✏️ Journée'
          ),
          button(
            `admin:add:${day.id}`,
            '➕ Match'
          ),
          button(
            `admin:preview:${day.id}`,
            '👀 Aperçu'
          ),
          button(
            `admin:schedule:${day.id}`,
            '📅 Programmer',
            ButtonStyle.Success,
            day.status === 'published'
          ),
          button(
            `admin:publish:${day.id}`,
            'Publier maintenant',
            ButtonStyle.Danger,
            day.status === 'published'
          )
        ),

        ...(m ? [
          row(
            button(
              `admin:editmatch:${day.id}:${m.id}`,
              '✏️ Ce match'
            ),
            button(
              `admin:result:${day.id}:${m.id}`,
              '✅ Résultat'
            ),
            button(
              `admin:invalidate:${day.id}:${m.id}`,
              'Invalider les choix',
              ButtonStyle.Danger
            ),
            button(
              `admin:delete:${day.id}:${m.id}`,
              'Supprimer le match',
              ButtonStyle.Danger
            )
          ),
          row(
            button(
              `admin:view:${day.id}:${index - 1}`,
              '← Match',
              ButtonStyle.Secondary,
              index === 0
            ),
            button(
              `admin:view:${day.id}:${index + 1}`,
              'Match →',
              ButtonStyle.Secondary,
              index === day.matches.length - 1
            )
          ),
        ] : []),

        row(
          button(
            `admin:pause:${day.id}`,
            day.status === 'scheduled'
              ? '⏸ Déprogrammer'
              : 'Retour brouillon',
            ButtonStyle.Secondary,
            day.status === 'published'
          ),
          button(
            `admin:deleteday:${day.id}`,
            'Supprimer la journée',
            ButtonStyle.Danger
          )
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }

  function adminList(state, page = 0) {
    const days = Object.values(state.days)
      .sort((a, b) => b.date.localeCompare(a.date));

    const count = Math.max(
      1,
      Math.ceil(days.length / 20)
    );

    page = Math.max(
      0,
      Math.min(Number(page) || 0, count - 1)
    );

    const part = days.slice(page * 20, page * 20 + 20);

    const e = embed(
      state,
      '⚙️ GOAT Betclic | Journées'
    ).setDescription(
      part.map(d =>
        `**${d.date}** | ${d.status} | ${d.matches.length} matchs | \`${d.id}\``
      ).join('\n') ||
      'Crée ta première journée avec /goat-admin creer.'
    );

    return {
      content: '',
      embeds: [e],
      components: [
        ...(part.length ? [
          row(
            new StringSelectMenuBuilder()
              .setCustomId('admin:listselect')
              .setPlaceholder('Ouvrir une journée')
              .addOptions(part.map(d => ({
                label: `${d.date} | ${d.title}`.slice(0, 100),
                value: d.id,
                description: `${d.status} | ${d.matches.length} matchs`,
              })))
          ),
        ] : []),

        row(
          button(
            'admin:create',
            '➕ Nouvelle journée',
            ButtonStyle.Success
          ),
          button(
            `admin:list:${page - 1}`,
            '←',
            ButtonStyle.Secondary,
            page === 0
          ),
          button(
            `admin:list:${page + 1}`,
            '→',
            ButtonStyle.Secondary,
            page === count - 1
          )
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }

  function modal(custom, title, fields) {
    return new ModalBuilder()
      .setCustomId(custom)
      .setTitle(title.slice(0, 45))
      .addComponents(fields.map(f => {
        const input = new TextInputBuilder()
          .setCustomId(f.id)
          .setLabel(f.label.slice(0, 45))
          .setStyle(
            f.long
              ? TextInputStyle.Paragraph
              : TextInputStyle.Short
          )
          .setRequired(f.required !== false)
          .setMaxLength(f.max || 1000);

        if (f.value) input.setValue(String(f.value));

        if (f.placeholder) {
          input.setPlaceholder(f.placeholder.slice(0, 100));
        }

        return row(input);
      }));
  }

  function dayModal(day) {
    return modal(
      `modal:day:${day?.id || 'new'}`,
      day ? 'Modifier la journée' : 'Nouvelle journée',
      [
        ...(day ? [] : [
          {
            id: 'date',
            label: 'Date de la journée : AAAA-MM-JJ',
            max: 10,
          },
        ]),
        {
          id: 'publish',
          label: 'Publication Paris : AAAA-MM-JJ HH:mm',
          value: day ? G.parisInput(day.publishAt) : '',
          max: 40,
        },
        {
          id: 'title',
          label: 'Titre',
          value: day?.title || 'GOAT BETCLIC | NBA',
          max: 200,
        },
        {
          id: 'image',
          label: 'Lien image HTTPS (facultatif)',
          value: day?.image,
          required: false,
        },
        {
          id: 'description',
          label: 'Texte de présentation (facultatif)',
          value: day?.description,
          required: false,
          long: true,
          max: 1500,
        },
      ]
    );
  }

  function matchModal(day, m) {
    return modal(
      `modal:match:${day.id}:${m?.id || 'new'}`,
      m ? 'Modifier le match' : 'Ajouter un match',
      [
        {
          id: 'home',
          label: 'Équipe A',
          value: m?.home,
          max: 70,
        },
        {
          id: 'away',
          label: 'Équipe B',
          value: m?.away,
          max: 70,
        },
        {
          id: 'odds',
          label: 'Cotes A / B, exemple 1,20 / 3,40',
          value: m
            ? `${m.homeOdds} / ${m.awayOdds}`
            : '',
          max: 40,
        },
        {
          id: 'start',
          label: 'Début Paris : AAAA-MM-JJ HH:mm',
          value: m ? G.parisInput(m.startAt) : '',
          max: 40,
        },
        {
          id: 'image',
          label: 'Image du match HTTPS (facultatif)',
          value: m?.image,
          required: false,
        },
      ]
    );
  }

  return {
    safe,
    time,
    embed,
    daily,
    matchCard,
    summary,
    leaderboard,
    adminDay,
    adminList,
    button,
    row,
    dayModal,
    matchModal,
  };
})();

const storage = (() => {
  const fs = require('node:fs/promises');
  const path = require('node:path');

  class Store {
    constructor(directory) {
      this.directory = directory;
      this.filename = path.join(directory, 'goat-data.json');
      this.queue = Promise.resolve();
      this.state = null;
    }

    async init(config) {
      await fs.mkdir(this.directory, { recursive: true });

      try {
        const data = JSON.parse(
          await fs.readFile(this.filename, 'utf8')
        );

        if (
          data.schema !== 1 ||
          !data.days ||
          !data.config
        ) {
          throw new Error('Format de sauvegarde invalide');
        }

        this.state = data;
      } catch (e) {
        // Ne jamais écraser une sauvegarde illisible.
        if (e.code !== 'ENOENT') throw e;

        this.state = game.initialState(config);
        await this.write(this.state);
      }
    }

    async write(data) {
      const temp = this.filename + '.tmp';
      const handle = await fs.open(temp, 'w', 0o600);

      try {
        await handle.writeFile(JSON.stringify(data));
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await fs.copyFile(
          this.filename,
          this.filename + '.bak'
        );
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      await fs.rename(temp, this.filename);

      const directory = await fs.open(this.directory, 'r');

      try {
        await directory.sync();
      } catch (e) {
        if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e;
      } finally {
        await directory.close();
      }
    }

    async read() {
      await this.queue;
      return structuredClone(this.state);
    }

    change(fn) {
      const operation = this.queue.then(async () => {
        const next = structuredClone(this.state);
        const result = await fn(next);

        await this.write(next);

        this.state = next;
        return structuredClone(result);
      });

      this.queue = operation.catch(() => {});

      return operation;
    }

    async close() {
      await this.queue;
    }
  }

  function createStore(env = process.env) {
    const directory =
      env.DATA_DIR ||
      env.RAILWAY_VOLUME_MOUNT_PATH ||
      './data';

    if (
      env.RAILWAY_ENVIRONMENT_ID &&
      !env.RAILWAY_VOLUME_MOUNT_PATH
    ) {
      throw new Error(
        'Attache un volume Railway au service avant de démarrer.'
      );
    }

    if (
      env.RAILWAY_VOLUME_MOUNT_PATH &&
      path.resolve(directory) !==
      path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH)
    ) {
      throw new Error(
        'DATA_DIR doit correspondre au chemin du volume Railway.'
      );
    }

    return new Store(directory);
  }

  return { Store, createStore };
})();

if (require.main !== module) {
  module.exports = { game, ui, storage };
} else {
  const {
    Client,
    GatewayIntentBits,
    Events,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    ChannelType,
    AttachmentBuilder,
  } = require('discord.js');

  const { createHash } = require('node:crypto');

  const G = game;
  const UI = ui;
  const { createStore } = storage;

  const env = process.env;
  const guildId = env.DISCORD_GUILD_ID?.trim();

  if (
    !env.DISCORD_TOKEN ||
    !/^\d{17,20}$/.test(guildId || '')
  ) {
    throw new Error(
      'DISCORD_TOKEN ou DISCORD_GUILD_ID manquant/invalide.'
    );
  }

  const adminIds = new Set(
    (env.ADMIN_USER_IDS || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
  );

  if (
    !adminIds.size ||
    [...adminIds].some(x => !/^\d{17,20}$/.test(x))
  ) {
    throw new Error(
      'Renseigne ADMIN_USER_IDS avec vos identifiants Discord.'
    );
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const store = createStore();
  const ephemeral = MessageFlags.Ephemeral;
  const quiet = { parse: [] };

  let timer;
  let ticking = false;
  let stopping = false;

  const commands = [
    new SlashCommandBuilder()
      .setName('goat')
      .setDescription(
        'Jouer au GOAT Betclic et consulter les classements'
      )
      .addSubcommand(s =>
        s.setName('jouer')
          .setDescription('Ouvrir une grille')
          .addStringOption(o =>
            o.setName('date')
              .setDescription(
                'Date de journée AAAA-MM-JJ, vide = dernière journée ouverte'
              )
          )
      )
      .addSubcommand(s =>
        s.setName('classement')
          .setDescription('Classement du jour ou de la semaine')
          .addStringOption(o =>
            o.setName('periode')
              .setDescription('Période')
              .addChoices(
                { name: 'Semaine', value: 'w' },
                { name: 'Jour', value: 'd' }
              )
          )
          .addStringOption(o =>
            o.setName('date')
              .setDescription('AAAA-MM-JJ, vide = aujourd’hui')
          )
      )
      .addSubcommand(s =>
        s.setName('regles')
          .setDescription('Les règles du GOAT Betclic')
      ),

    new SlashCommandBuilder()
      .setName('goat-admin')
      .setDescription(
        'Gérer les journées, les résultats et la programmation'
      )
      .setDefaultMemberPermissions(
        PermissionFlagsBits.ManageGuild
      )
      .addSubcommand(s =>
        s.setName('config')
          .setDescription('Configurer le salon et les annonces')
          .addChannelOption(o =>
            o.setName('salon')
              .setDescription('Salon des grilles')
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
              .setRequired(true)
          )
          .addRoleOption(o =>
            o.setName('notification')
              .setDescription(
                'Rôle à notifier, vide = aucun ping'
              )
          )
      )
      .addSubcommand(s =>
        s.setName('creer')
          .setDescription(
            'Créer une journée avec image et horaire'
          )
      )
      .addSubcommand(s =>
        s.setName('liste')
          .setDescription(
            'Toutes les journées et leur panneau de gestion'
          )
      )
      .addSubcommand(s =>
        s.setName('jour')
          .setDescription('Ouvrir le panneau d’une journée')
          .addStringOption(o =>
            o.setName('date')
              .setDescription('AAAA-MM-JJ')
              .setRequired(true)
          )
      )
      .addSubcommand(s =>
        s.setName('resultat')
          .setDescription(
            'Saisir ou corriger le résultat d’un match'
          )
          .addStringOption(o =>
            o.setName('match')
              .setDescription(
                'ID du match affiché dans le panneau'
              )
              .setRequired(true)
          )
          .addStringOption(o =>
            o.setName('gagnant')
              .setDescription('Résultat')
              .setRequired(true)
              .addChoices(
                { name: 'Équipe A', value: 'home' },
                { name: 'Équipe B', value: 'away' },
                {
                  name: 'Annulé / aucun point',
                  value: 'void',
                },
                { name: 'En attente', value: 'pending' }
              )
          )
      )
      .addSubcommand(s =>
        s.setName('publier-classement')
          .setDescription(
            'Publier manuellement un classement dans le salon de ton choix'
          )
          .addStringOption(o =>
            o.setName('periode')
              .setDescription('Période')
              .setRequired(true)
              .addChoices(
                { name: 'Semaine', value: 'w' },
                { name: 'Jour', value: 'd' }
              )
          )
          .addStringOption(o =>
            o.setName('date')
              .setDescription('AAAA-MM-JJ, vide = aujourd’hui')
          )
          .addChannelOption(o =>
            o.setName('salon')
              .setDescription(
                'Salon de publication, vide = salon de la commande'
              )
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
              )
          )
      )
      .addSubcommand(s =>
        s.setName('reset')
          .setDescription(
            'Réinitialiser une semaine avec confirmation et archive'
          )
          .addStringOption(o =>
            o.setName('semaine')
              .setDescription('Date du lundi AAAA-MM-JJ')
              .setRequired(true)
          )
      )
      .addSubcommand(s =>
        s.setName('export')
          .setDescription(
            'Exporter le classement et les pronostics en CSV'
          )
          .addStringOption(o =>
            o.setName('semaine')
              .setDescription(
                'Date du lundi AAAA-MM-JJ, vide = semaine actuelle'
              )
          )
      )
      .addSubcommand(s =>
        s.setName('diagnostic')
          .setDescription(
            'Vérifier les salons, le stockage et les publications'
          )
      ),
  ];

  function log(label, error) {
    // Aucun secret ni objet d’erreur complet dans les logs.
    console.error(
      `${label}: ${error?.code || error?.name || 'Erreur'}`
    );
  }

  function assertGuild(i) {
    G.need(
      i.guildId === guildId,
      'Commande disponible uniquement sur le serveur configuré.'
    );
  }

  function assertAdmin(i) {
    assertGuild(i);

    G.need(
      adminIds.has(i.user.id),
      'Cette action est réservée à l’équipe autorisée.'
    );
  }

  function getByDate(state, date) {
    return Object.values(state.days)
      .find(d => d.date === G.dateKey(date));
  }

  function currentDay(state) {
    return Object.values(state.days)
      .filter(d =>
        d.status === 'published' &&
        d.matches.some(m => G.open(m, Date.now()))
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0];
  }

  function scopeFor(period, date) {
    date = G.dateKey(
      date || G.nowParis().toISODate()
    );

    return period === 'd'
      ? { date }
      : { week: G.weekKey(date) };
  }

  async function textChannel(id) {
    G.need(
      id,
      'Configure le salon avec /goat-admin config.'
    );

    const c = await client.channels.fetch(id);

    G.need(
      c &&
      c.guildId === guildId &&
      [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
      ].includes(c.type),
      'Salon texte inaccessible.'
    );

    G.need(
      c.permissionsFor(client.user)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
      'Le bot doit pouvoir voir le salon, envoyer des messages, intégrer des liens et lire l’historique.'
    );

    return c;
  }

  function marker(key) {
    return `GOAT:${key}`;
  }

  function marked(payload, key) {
    const embeds = payload.embeds.map(e =>
      e.toJSON
        ? e.toJSON()
        : structuredClone(e)
    );

    const last = embeds[embeds.length - 1];

    last.footer = {
      ...(last.footer || {}),
      text: `${last.footer?.text || ''} | ${marker(key)}`,
    };

    return { ...payload, embeds };
  }

  async function recoverMessage(channel, receipt, key) {
    if (receipt.id) {
      try {
        return await channel.messages.fetch(receipt.id);
      } catch (e) {
        if (e.code !== 10008) throw e;
        return null;
      }
    }

    // Retrouver un envoi réalisé juste avant un crash.
    let before;

    for (let page = 0; page < 100; page++) {
      const messages = await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!messages.size) return null;

      const found = messages.find(m =>
        m.author.id === client.user.id &&
        m.embeds.some(e =>
          e.footer?.text?.includes(marker(key))
        )
      );

      if (found) return found;

      const oldest = messages.last();

      if (
        oldest.createdTimestamp <
        receipt.createdAt - 10000
      ) {
        return null;
      }

      before = oldest.id;
    }

    throw new Error(
      'Historique trop long pour vérifier la publication. Intervention administrateur nécessaire.'
    );
  }

  async function deliver(
    key,
    channelId,
    payload,
    options = {}
  ) {
    const channel = await textChannel(channelId);

    let receipt = (
      await store.read()
    ).deliveries?.[key];

    if (!receipt) {
      receipt = await store.change(state => {
        state.deliveries ||= {};

        if (!state.deliveries[key]) {
          state.deliveries[key] = {
            channelId,
            createdAt: Date.now(),
            id: null,
          };
        }

        return structuredClone(state.deliveries[key]);
      });
    }

    G.need(
      receipt.channelId === channelId,
      'Cette publication appartient à un autre salon. Modifie-la dans son salon d’origine.'
    );

    const data = marked(payload, key);

    const digest = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');

    if (receipt.id && receipt.digest === digest) {
      return { id: receipt.id };
    }

    const old = await recoverMessage(
      channel,
      receipt,
      key
    );

    let message;

    if (old) {
      if (options.edit && receipt.digest === digest) {
        return old;
      }

      if (options.edit) {
        message = await old.edit({
          ...data,
          content: options.content || '',
          allowedMentions: quiet,
        });
      } else {
        return old;
      }
    } else {
      const nonce = BigInt(
        `0x${createHash('sha256')
          .update(`${key}:${receipt.createdAt}`)
          .digest('hex')
          .slice(0, 16)}`
      ).toString();

      message = await channel.send({
        ...data,
        content: options.content || '',
        allowedMentions: options.role
          ? { roles: [options.role], parse: [] }
          : quiet,
        nonce,
        enforceNonce: true,
      });
    }

    await store.change(state => {
      state.deliveries[key].id = message.id;
      state.deliveries[key].digest = digest;
    });

    return message;
  }

  async function tick() {
    if (
      ticking ||
      stopping ||
      !client.isReady()
    ) {
      return;
    }

    ticking = true;

    try {
      const state = await store.read();

      const days = Object.values(state.days)
        .sort((a, b) => a.publishAt - b.publishAt);

      for (const day of days) {
        try {
          const due =
            day.status === 'scheduled' &&
            day.publishAt <= Date.now();

          const edited =
            day.status === 'published' &&
            day.dirty;

          if (!due && !edited) continue;

          const target =
            day.post?.channelId ||
            state.config.channelId;

          const role = day.status === 'scheduled'
            ? state.config.notificationRole
            : null;

          const msg = await deliver(
            `day:${day.id}`,
            target,
            UI.daily(state, day),
            {
              edit: true,
              role,
              content: role ? `<@&${role}>` : '',
            }
          );

          await store.change(s => {
            const current = G.getDay(s, day.id);

            current.status = 'published';
            current.post = {
              id: msg.id,
              channelId: target,
            };

            if (current.version === day.version) {
              current.dirty = false;
            }
          });
        } catch (e) {
          log(`Publication journée ${day.id}`, e);
        }
      }

      // Aucun classement automatique.
      // Seules les journées de jeu sont programmées ici.
    } catch (e) {
      log('Programmation', e);
    } finally {
      ticking = false;
    }
  }

  async function handleSlash(i) {
    assertGuild(i);

    if (i.commandName === 'goat-admin') {
      assertAdmin(i);
    }

    const sub = i.options.getSubcommand();

    if (
      i.commandName === 'goat-admin' &&
      sub === 'creer'
    ) {
      return i.showModal(UI.dayModal());
    }

    await i.deferReply({ flags: ephemeral });

    if (i.commandName === 'goat') {
      if (sub === 'regles') {
        const state = await store.read();

        return i.editReply({
          embeds: [
            UI.embed(
              state,
              '🏀 GOAT Betclic | Les règles'
            ).setDescription([
              'Choisis une équipe gagnante par match. **Un bon pronostic rapporte 2 points.**',
              '**Un seul boost par journée** : un bon pronostic boosté rapporte **4 points**. Un mauvais choix rapporte 0 point.',
              'Les cotes Betclic sont affichées à titre indicatif et ne multiplient pas les points. Aucun argent n’est misé dans ce jeu Discord.',
              'Les choix restent modifiables avant le début de chaque match. Clique sur **Valider ma grille** après tes modifications.',
              'Le boost reste verrouillé lorsque son match commence. Un match annulé rapporte 0 point, boost inclus.',
              'Chaque semaine va du lundi au dimanche selon la date de la journée affichée. Les matchs de nuit appartiennent à cette journée.',
              'Égalités : points, bons pronostics, puis boosts gagnants. Si les trois sont identiques, les membres restent ex æquo.',
              'Les récompenses et leurs conditions sont annoncées par l’équipe. Les Freebets sont des crédits de jeu non retirables.',
            ].join('\n\n')),
          ],
          allowedMentions: quiet,
        });
      }

      if (sub === 'classement') {
        return i.editReply(
          UI.leaderboard(
            await store.read(),
            scopeFor(
              i.options.getString('periode'),
              i.options.getString('date')
            )
          )
        );
      }

      const state = await store.read();
      const date = i.options.getString('date');

      const day = date
        ? getByDate(state, date)
        : currentDay(state);

      G.need(
        day && day.status === 'published',
        'Aucune journée publiée disponible.'
      );

      const snapshot = await store.change(s => {
        G.draftFor(
          G.getDay(s, day.id),
          i.user.id
        );

        return s;
      });

      return i.editReply(
        UI.matchCard(
          snapshot,
          snapshot.days[day.id],
          i.user.id
        )
      );
    }

    if (sub === 'config') {
      const channelId =
        i.options.getChannel('salon').id;

      await textChannel(channelId);

      await store.change(s => {
        Object.assign(s.config, {
          channelId,
          notificationRole:
            i.options.getRole('notification')?.id ||
            null,
        });

        G.audit(s, i.user.id, 'config', {
          channelId,
        });
      });

      return i.editReply(
        '✅ Salon enregistré. Les futures journées utiliseront cette configuration.'
      );
    }

    const state = await store.read();

    if (sub === 'liste') {
      return i.editReply(UI.adminList(state));
    }

    if (sub === 'jour') {
      const day = getByDate(
        state,
        i.options.getString('date')
      );

      G.need(day, 'Aucune journée à cette date.');

      return i.editReply(UI.adminDay(state, day));
    }

    if (sub === 'resultat') {
      const mid = i.options.getString('match');
      const result = i.options.getString('gagnant');

      await store.change(s => {
        const day = Object.values(s.days)
          .find(d =>
            d.matches.some(m => m.id === mid)
          );

        G.need(day, 'ID match inconnu.');

        G.setResult(
          day,
          mid,
          result === 'pending' ? null : result
        );

        G.audit(s, i.user.id, 'resultat', {
          day: day.id,
          mid,
          result,
        });
      });

      void tick();

      return i.editReply(
        '✅ Résultat enregistré. Les points et les classements sont recalculés automatiquement.'
      );
    }

    if (sub === 'publier-classement') {
      const scope = scopeFor(
        i.options.getString('periode'),
        i.options.getString('date')
      );

      const channel = await textChannel(
        i.options.getChannel('salon')?.id ||
        i.channelId
      );

      await channel.send(
        UI.leaderboard(state, scope)
      );

      return i.editReply('✅ Classement publié.');
    }

    if (sub === 'reset') {
      const week = G.dateKey(
        i.options.getString('semaine')
      );

      G.need(
        G.weekKey(week) === week,
        'Indique la date du lundi de la semaine.'
      );

      return i.editReply({
        content:
          `⚠️ Réinitialiser les pronostics et les points ` +
          `de la semaine du ${week} ? Une copie est conservée ` +
          'dans la sauvegarde. Les matchs et leurs résultats ne sont pas supprimés.',
        components: [
          UI.row(
            UI.button(
              `admin:reset:${week}`,
              'Confirmer le reset',
              4
            ),
            UI.button(
              'admin:list:0',
              'Annuler'
            )
          ),
        ],
      });
    }

    if (sub === 'export') {
      const week = G.weekKey(
        i.options.getString('semaine') ||
        G.nowParis().toISODate()
      );

      const csv = value =>
        `"${String(value ?? '')
          .replaceAll('"', '""')
          .replace(/^[=+\-@]/, "'$&")}"`;

      const rows = [[
        'date',
        'discord_id',
        'pseudo',
        'match_id',
        'equipe_A',
        'equipe_B',
        'choix',
        'boost',
        'resultat',
        'points',
      ]];

      const days = Object.values(state.days)
        .filter(d => d.week === week);

      for (const d of days) {
        for (const [uid, v] of Object.entries(d.votes)) {
          for (const m of d.matches) {
            const p = v.picks[m.id];

            if (
              !p ||
              p.revision !== m.revision
            ) {
              continue;
            }

            rows.push([
              d.date,
              uid,
              v.name,
              m.id,
              m.home,
              m.away,
              p.side === 'home' ? m.home : m.away,
              v.boost === m.id ? 'oui' : 'non',
              m.result || 'en attente',
              m.result === p.side
                ? (v.boost === m.id ? 4 : 2)
                : 0,
            ]);
          }
        }
      }

      const leaderboard = [
        [
          'rang',
          'discord_id',
          'pseudo',
          'points',
          'bons_choix',
          'boosts_gagnants',
        ],
        ...G.ranking(state, { week }).map(r => [
          r.rank,
          r.uid,
          r.name,
          r.points,
          r.wins,
          r.boostedWins,
        ]),
      ];

      const file = (r, name) => new AttachmentBuilder(
        Buffer.from(
          '\uFEFF' +
          r.map(x =>
            x.map(csv).join(';')
          ).join('\r\n')
        ),
        { name }
      );

      return i.editReply({
        content: `📁 Exports de la semaine du ${week}`,
        files: [
          file(
            rows,
            `pronostics-${week}.csv`
          ),
          file(
            leaderboard,
            `classement-${week}.csv`
          ),
        ],
      });
    }

    if (sub === 'diagnostic') {
      const channel = await textChannel(
        state.config.channelId
      );

      const days = Object.values(state.days);

      const pending = days
        .flatMap(d => d.matches)
        .filter(m =>
          m.result === null &&
          m.lockAt < Date.now()
        ).length;

      return i.editReply({
        content: [
          '✅ Volume accessible',
          `✅ Salon : <#${channel.id}>`,
          `🗓 ${days.filter(d => d.status === 'scheduled').length} journées programmées`,
          `📣 ${days.filter(d => d.status === 'published').length} journées publiées`,
          `⏳ ${pending} résultats à saisir`,
          '🕰 Fuseau : Europe/Paris',
          '🏆 Classements : publication manuelle uniquement',
          `📦 ${state.resetArchives.length} archives de reset`,
        ].join('\n'),
        allowedMentions: quiet,
      });
    }
  }

  async function handleAdmin(i, bits) {
    assertAdmin(i);

    const [, action, did, mid] = bits;

    if (action === 'create') {
      return i.showModal(UI.dayModal());
    }

    const state = await store.read();

    if (action === 'listselect') {
      await i.deferUpdate();

      return i.editReply(
        UI.adminDay(
          state,
          G.getDay(state, i.values[0])
        )
      );
    }

    if (action === 'list') {
      await i.deferUpdate();

      return i.editReply(
        UI.adminList(state, did)
      );
    }

    if (action === 'reset') {
      await i.deferUpdate();

      await store.change(s => {
        G.resetWeek(s, did);

        G.audit(s, i.user.id, 'reset', {
          week: did,
        });
      });

      return i.editReply({
        content: `✅ Semaine ${did} réinitialisée et copie archivée.`,
        embeds: [],
        components: [],
      });
    }

    const day = G.getDay(state, did);

    if (action === 'editday') {
      return i.showModal(UI.dayModal(day));
    }

    if (action === 'add') {
      return i.showModal(UI.matchModal(day));
    }

    if (action === 'editmatch') {
      return i.showModal(
        UI.matchModal(
          day,
          G.getMatch(day, mid)
        )
      );
    }

    await i.deferUpdate();

    if (action === 'preview') {
      return i.editReply({
        ...UI.daily(state, day),
        components: [
          UI.row(
            UI.button(
              `admin:view:${did}:0`,
              '← Gestion'
            )
          ),
        ],
        content: '👀 Aperçu privé : rien n’a été publié.',
      });
    }

    if (action === 'result') {
      const m = G.getMatch(day, mid);

      return i.editReply({
        content:
          `Résultat de **${UI.safe(m.home)} / ` +
          `${UI.safe(m.away)}**`,
        embeds: [],
        components: [
          UI.row(
            UI.button(
              `admin:setresult:${did}:${mid}:home`,
              m.home,
              3
            ),
            UI.button(
              `admin:setresult:${did}:${mid}:away`,
              m.away,
              3
            ),
            UI.button(
              `admin:setresult:${did}:${mid}:void`,
              'Annulé'
            ),
            UI.button(
              `admin:setresult:${did}:${mid}:pending`,
              'En attente'
            ),
            UI.button(
              `admin:view:${did}:0`,
              'Retour'
            )
          ),
        ],
        allowedMentions: quiet,
      });
    }

    if (
      ['invalidate', 'delete', 'deleteday']
        .includes(action)
    ) {
      const content = action === 'deleteday'
        ? '⚠️ Supprimer cette journée ? Possible uniquement sans pronostics validés.'
        : action === 'invalidate'
          ? '⚠️ Effacer tous les choix et boosts sur ce match ? Les points seront retirés et les joueurs devront le rejouer s’il est encore ouvert.'
          : '⚠️ Supprimer ce match ? Possible uniquement si aucun pronostic n’a été validé dessus. Sinon, utilise le résultat « Annulé ».';

      return i.editReply({
        content,
        embeds: [],
        components: [
          UI.row(
            UI.button(
              `admin:confirm-${action}:${did}:${mid || ''}`,
              'Confirmer',
              4
            ),
            UI.button(
              `admin:view:${did}:0`,
              'Annuler'
            )
          ),
        ],
      });
    }

    let note = '';

    await store.change(s => {
      const d = G.getDay(s, did);

      if (action === 'schedule') {
        G.schedule(d);
        note = '✅ Journée programmée.';
      }

      if (action === 'publish') {
        G.need(
          d.status !== 'published',
          'Journée déjà publiée.'
        );

        G.need(
          d.matches.length &&
          d.matches.some(m => G.open(m, Date.now())),
          'Ajoute au moins un match encore ouvert.'
        );

        d.publishAt = Date.now();
        d.status = 'scheduled';

        note = '✅ Publication demandée. Elle apparaîtra sous quelques secondes.';
      }

      if (action === 'pause') {
        G.need(
          d.status !== 'published',
          'Une journée publiée ne peut pas être déprogrammée.'
        );

        d.status = 'draft';
        note = '✅ Programmation désactivée.';
      }

      if (action === 'setresult') {
        G.setResult(
          d,
          mid,
          bits[4] === 'pending' ? null : bits[4]
        );

        note = '✅ Résultat enregistré.';
      }

      if (action === 'confirm-invalidate') {
        G.invalidate(d, mid);

        note = '✅ Choix invalidés. Tu peux maintenant modifier les équipes.';
      }

      if (action === 'confirm-delete') {
        G.getMatch(d, mid);

        G.need(
          !Object.values(d.votes)
            .some(v => v.picks[mid]),
          'Des pronostics existent : annule le match au lieu de le supprimer.'
        );

        d.matches = d.matches.filter(m => m.id !== mid);

        for (const draft of Object.values(d.drafts)) {
          delete draft.picks[mid];

          if (draft.boost === mid) {
            draft.boost = null;
          }
        }

        d.version++;
        d.dirty = true;
        note = '✅ Match supprimé.';
      }

      if (action === 'confirm-deleteday') {
        G.need(
          !Object.keys(d.votes).length,
          'Des participants ont validé leur grille. Conserve la journée et annule les matchs si nécessaire.'
        );

        G.need(
          d.status !== 'published',
          'Une journée publiée est conservée dans les archives.'
        );

        delete s.days[did];

        note = '✅ Journée supprimée.';
      }

      if (action !== 'view') {
        G.audit(s, i.user.id, action, {
          day: did,
          mid,
        });
      }
    });

    const after = await store.read();

    if (!after.days[did]) {
      return i.editReply({
        ...UI.adminList(after),
        content: note,
      });
    }

    const payload = UI.adminDay(
      after,
      after.days[did],
      action === 'view' ? mid : 0
    );

    payload.content = note;

    await i.editReply(payload);

    void tick();
  }

  async function handlePlayer(i, bits) {
    assertGuild(i);

    const [
      action,
      did,
      third,
      fourth,
      fifth,
      sixth,
    ] = bits;

    const privateMessage = i.message.flags.has(
      MessageFlags.Ephemeral
    );

    if (privateMessage) {
      await i.deferUpdate();
    } else {
      await i.deferReply({ flags: ephemeral });
    }

    const user = i.user.id;

    if (action === 'rank') {
      return i.editReply({
        content: '',
        ...UI.leaderboard(
          await store.read(),
          scopeFor(did, third),
          fourth
        ),
      });
    }

    let note = '';

    const state = await store.change(s => {
      const d = G.getDay(s, did);

      G.need(
        d.status === 'published',
        'Journée non publiée.'
      );

      G.draftFor(d, user);

      if (action === 'pick') {
        G.draftPick(
          d,
          user,
          third,
          fourth,
          Number(fifth)
        );
      }

      if (action === 'boost') {
        G.draftBoost(d, user, third);
      }

      if (action === 'discard') {
        d.drafts[user] = {
          ...structuredClone(
            d.votes[user] || {
              picks: {},
              boost: null,
            }
          ),
          version: (
            d.drafts[user]?.version || 0
          ) + 1,
        };
      }

      if (action === 'confirm') {
        G.need(
          d.version === Number(third) &&
          (d.drafts[user].version || 0) === Number(fourth),
          'La grille a changé depuis le récapitulatif. Rouvre le récapitulatif avant de valider.'
        );

        const result = G.commit(
          d,
          user,
          i.member?.displayName ||
          i.user.globalName ||
          i.user.username
        );

        s.users[user] = {
          name:
            i.member?.displayName ||
            i.user.username,
        };

        note =
          `✅ **${result.count} pronostic(s) validé(s).** ` +
          (
            result.boost
              ? 'Boost x2 enregistré.'
              : 'Aucun boost sélectionné.'
          ) +
          (
            result.skipped
              ? (
                `\n⚠️ ${result.skipped} modification(s) ` +
                'non enregistrée(s), car le match s’est fermé. ' +
                'Les choix précédemment validés sont conservés.'
              )
              : ''
          );
      }

      return s;
    });

    const day = state.days[did];

    if (
      ['summary', 'confirm', 'discard']
        .includes(action)
    ) {
      return i.editReply({
        ...UI.summary(
          state,
          day,
          user,
          action === 'summary' ? third : 0
        ),
        content: note,
      });
    }

    const index = action === 'pick'
      ? sixth
      : action === 'boost'
        ? fourth
        : third;

    return i.editReply(
      UI.matchCard(state, day, user, index)
    );
  }

  async function handleModal(i) {
    assertAdmin(i);

    await i.deferReply({ flags: ephemeral });

    const [, kind, did, mid] = i.customId.split(':');

    const f = name =>
      i.fields.getTextInputValue(name).trim();

    let dayId;

    await store.change(s => {
      if (kind === 'day') {
        const input = {
          title: f('title'),
          publish: f('publish'),
          image: f('image'),
          description: f('description'),
        };

        if (did === 'new') {
          dayId = G.createDay(s, {
            ...input,
            date: f('date'),
          }).id;
        } else {
          const d = G.getDay(s, did);

          G.editDay(d, input);
          dayId = did;

          if (d.status === 'scheduled') {
            G.need(
              d.matches.every(m =>
                d.publishAt < m.lockAt
              ),
              'La publication doit précéder tous les matchs.'
            );
          }
        }
      } else if (kind === 'match') {
        const odds = f('odds')
          .split('/')
          .map(x => x.trim());

        G.need(
          odds.length === 2,
          'Cotes attendues : 1,20 / 3,40.'
        );

        const d = G.getDay(s, did);

        G.saveMatch(
          d,
          {
            home: f('home'),
            away: f('away'),
            homeOdds: odds[0],
            awayOdds: odds[1],
            start: f('start'),
            image: f('image'),
          },
          mid === 'new' ? null : mid
        );

        if (d.status === 'scheduled') {
          G.need(
            d.matches.every(m =>
              d.publishAt < m.lockAt
            ),
            'Le match doit commencer après la publication programmée.'
          );
        }

        dayId = did;
      } else {
        throw new G.UserError('Formulaire inconnu.');
      }

      G.audit(
        s,
        i.user.id,
        `formulaire-${kind}`,
        {
          day: dayId,
          mid,
        }
      );
    });

    const state = await store.read();

    await i.editReply({
      ...UI.adminDay(
        state,
        state.days[dayId]
      ),
      content: '✅ Enregistré. Tu peux continuer à modifier ou programmer la journée.',
    });

    void tick();
  }

  client.on(Events.InteractionCreate, async i => {
    if (stopping) return;

    try {
      if (
        i.isChatInputCommand() &&
        ['goat', 'goat-admin'].includes(i.commandName)
      ) {
        await handleSlash(i);
      } else if (
        i.isModalSubmit() &&
        i.customId.startsWith('modal:')
      ) {
        await handleModal(i);
      } else if (
        (i.isButton() || i.isStringSelectMenu()) &&
        /^(admin|play|pick|boost|summary|confirm|discard|rank):/
          .test(i.customId)
      ) {
        const bits = i.customId.split(':');

        if (bits[0] === 'admin') {
          await handleAdmin(i, bits);
        } else {
          await handlePlayer(i, bits);
        }
      }
    } catch (e) {
      if (!(e instanceof G.UserError)) {
        log('Interaction', e);
      }

      const content = e instanceof G.UserError
        ? `⚠️ ${e.message}`
        : 'Une erreur est survenue. Tes données déjà enregistrées sont conservées. Préviens l’équipe si cela persiste.';

      try {
        if (i.deferred || i.replied) {
          await i.followUp({
            content,
            flags: ephemeral,
            allowedMentions: quiet,
          });
        } else {
          await i.reply({
            content,
            flags: ephemeral,
            allowedMentions: quiet,
          });
        }
      } catch (replyError) {
        log('Réponse erreur', replyError);
      }
    }
  });

  client.on(Events.Error, e => log('Discord', e));

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);

      for (const cmd of commands) {
        await guild.commands.create(cmd.toJSON());
      }

      console.log(
        'GOAT Betclic prêt. Stockage sur volume, horaires Europe/Paris. Classements manuels.'
      );

      await tick();

      timer = setInterval(
        () => void tick(),
        15000
      );
    } catch (e) {
      log('Initialisation Discord', e);
      await shutdown(1);
    }
  });

  async function shutdown(code = 0) {
    if (stopping) return;

    stopping = true;
    clearInterval(timer);
    client.destroy();

    await store.close().catch(() => {});

    process.exit(code);
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => void shutdown());
  }

  process.once('uncaughtException', e => {
    log('Erreur fatale', e);
    void shutdown(1);
  });

  process.once('unhandledRejection', e => {
    log('Erreur fatale', e);
    void shutdown(1);
  });

  async function start() {
    await store.init({
      channelId: env.GOAT_CHANNEL_ID || null,
      color: env.GOAT_COLOR || '#E31B23',
      logo: G.imageURL(env.GOAT_LOGO_URL),
      notificationRole:
        env.NOTIFICATION_ROLE_ID || null,
    });

    await client.login(env.DISCORD_TOKEN);
  }

  start().catch(e => {
    log('Démarrage', e);
    void shutdown(1);
  });
}
