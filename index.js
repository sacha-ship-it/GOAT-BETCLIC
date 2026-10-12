'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  AttachmentBuilder,
  escapeMarkdown,
} = require('discord.js');

const {
  randomUUID,
  createHash,
} = require('node:crypto');

const fs = require('node:fs/promises');
const path = require('node:path');

const ZONE = 'Europe/Paris';

const RED = /^#[a-f\d]{6}$/i.test(process.env.GOAT_COLOR || '')
  ? process.env.GOAT_COLOR
  : '#E31B23';

const id = () => randomUUID()
  .replaceAll('-', '')
  .slice(0, 16);

class UserError extends Error {}

function need(condition, text) {
  if (!condition) throw new UserError(text);
}

const safe = text => escapeMarkdown(String(text))
  .replaceAll('@', '@\u200b');

const row = (...items) => new ActionRowBuilder()
  .addComponents(items);

function btn(
  key,
  label,
  style = ButtonStyle.Secondary,
  disabled = false
) {
  return new ButtonBuilder()
    .setCustomId(key)
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled);
}

const fmtOdd = value => value.toLocaleString('fr-FR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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

  return shiftDate(
    date,
    -(weekday === 0 ? 6 : weekday - 1)
  );
}

function parseTime(value) {
  let text = value.trim();

  // Format conseillé : 07:00 2026-10-20.
  // L'ancien format 2026-10-20 07:00 reste accepté.
  if (/^\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/.test(text)) {
    text = text.slice(6) + ' ' + text.slice(0, 5);
  }

  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    dateKey(text.slice(0, 10));

    const ms = Date.parse(text);

    need(
      Number.isFinite(ms),
      'Date/heure ISO invalide.'
    );

    return ms;
  }

  need(
    /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(text),
    'Date/heure attendue : HH:mm AAAA-MM-JJ, heure de Paris.'
  );

  dateKey(text.slice(0, 10));

  const utc = Date.parse(
    text.replace(' ', 'T') + ':00Z'
  );

  const candidates = [];

  for (let offset = -180; offset <= 180; offset += 30) {
    const ms = utc + offset * 60000;

    if (parisInput(ms) === text) {
      candidates.push(ms);
    }
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

  need(
    url.length <= 1000,
    'Lien image trop long.'
  );

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

function initialState() {
  return {
    schema: 2,
    matches: {},
    votes: {},
    drafts: {},
    boosts: {},
    pending: {},
    archives: [],
    audit: [],
  };
}

// Préserve les données de la version précédente.
function migrate(old) {
  if (
    old.schema === 2 &&
    old.matches &&
    old.votes &&
    old.boosts
  ) {
    return old;
  }

  need(
    old.schema === 1 && old.days,
    'Sauvegarde illisible : ne la supprime pas.'
  );

  const s = initialState();

  s.archives.push({
    action: 'migration',
    at: Date.now(),
    data: old,
  });

  s.legacyDays = {};

  for (const d of Object.values(old.days)) {
    s.legacyDays[d.id] = [];

    for (const [index, x] of d.matches.entries()) {
      s.matches[x.id] = {
        id: x.id,
        title: `${x.home} / ${x.away}`,
        home: x.home,
        away: x.away,
        homeOdds: x.homeOdds,
        awayOdds: x.awayOdds,
        date: d.date,
        publishAt: d.publishAt,
        closeAt: x.lockAt,
        channelId:
          d.post?.channelId ||
          old.config.channelId,
        description: d.description || '',
        image: x.image || d.image || '',
        imageFile: '',
        roleId: null,
        status: d.status === 'draft'
          ? 'draft'
          : d.status,
        result: x.result,
        revision: x.revision,
        version: 1,
        dirty: false,
        post: index === 0 ? d.post : null,
        createdAt: d.createdAt,
      };

      s.legacyDays[d.id].push(x.id);
      s.votes[x.id] = {};

      for (const [uid, v] of Object.entries(d.votes)) {
        if (v.picks[x.id]) {
          s.votes[x.id][uid] = {
            ...v.picks[x.id],
            name: v.name || uid,
          };
        }

        if (v.boost === x.id) {
          s.boosts[d.date] ||= {};
          s.boosts[d.date][uid] = x.id;
        }
      }
    }
  }

  return s;
}

class Store {
  constructor(directory) {
    this.directory = directory;
    this.filename = path.join(
      directory,
      'goat-data.json'
    );

    this.queue = Promise.resolve();
    this.state = null;
  }

  async init() {
    await fs.mkdir(this.directory, {
      recursive: true,
    });

    try {
      const data = JSON.parse(
        await fs.readFile(this.filename, 'utf8')
      );

      this.state = migrate(data);
    } catch (e) {
      // Ne jamais écraser une sauvegarde illisible.
      if (e.code !== 'ENOENT') throw e;

      this.state = initialState();
      await this.write(this.state);
    }
  }

  async write(data) {
    const temp = this.filename + '.tmp';

    const handle = await fs.open(
      temp,
      'w',
      0o600
    );

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

    const directory = await fs.open(
      this.directory,
      'r'
    );

    try {
      await directory.sync();
    } catch (e) {
      if (!['EINVAL', 'ENOTSUP'].includes(e.code)) {
        throw e;
      }
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

function available(m, now = Date.now()) {
  return (
    m.status === 'published' &&
    m.result === null &&
    now < m.closeAt
  );
}

function match(s, mid) {
  const m = s.matches[mid];

  need(
    m && m.status !== 'deleted',
    'Match introuvable. Utilise /goat list pour retrouver son ID.'
  );

  return m;
}

function audit(s, uid, action, mid) {
  s.audit.push({
    at: Date.now(),
    uid,
    action,
    mid,
  });

  if (s.audit.length > 2000) {
    s.audit.splice(0, s.audit.length - 2000);
  }
}

function validate(m) {
  m.title = clean(m.title, 200, 'Titre');
  m.home = clean(m.home, 70, 'Équipe A');
  m.away = clean(m.away, 70, 'Équipe B');

  need(
    m.home.toLowerCase() !== m.away.toLowerCase(),
    'Les deux équipes doivent être différentes.'
  );

  m.homeOdds = odd(m.homeOdds);
  m.awayOdds = odd(m.awayOdds);
  m.date = dateKey(m.date);
  m.image = imageURL(m.image);

  m.description = String(m.description || '')
    .replace(/[\u2013\u2014]/g, '-')
    .slice(0, 1500);

  need(
    m.publishAt < m.closeAt,
    'La publication doit avoir lieu avant la fermeture.'
  );

  need(
    /^\d{17,20}$/.test(m.channelId || ''),
    'Salon invalide.'
  );
}

function clearChoices(s, m) {
  s.archives.push({
    action: 'invalidation',
    at: Date.now(),
    match: structuredClone(m),
    votes: structuredClone(s.votes[m.id] || {}),
  });

  s.votes[m.id] = {};
  s.drafts[m.id] = {};

  for (const perDay of Object.values(s.boosts)) {
    for (const [uid, mid] of Object.entries(perDay)) {
      if (mid === m.id) {
        delete perDay[uid];
      }
    }
  }

  m.revision++;
  m.result = null;
}

function confirmPick(
  s,
  mid,
  uid,
  side,
  boosted,
  revision,
  name,
  now = Date.now()
) {
  const m = match(s, mid);

  need(
    available(m, now),
    'Ce match est fermé.'
  );

  need(
    revision === m.revision,
    'Le match a été modifié. Reprends ton choix sur le message publié.'
  );

  need(
    ['home', 'away'].includes(side),
    'Choix invalide.'
  );

  s.boosts[m.date] ||= {};

  const old = s.boosts[m.date][uid];

  if (old && old !== mid && boosted) {
    const other = s.matches[old];

    need(
      other && available(other, now),
      'Ton boost est déjà verrouillé sur un match commencé ou clôturé.'
    );
  }

  s.votes[mid] ||= {};

  s.votes[mid][uid] = {
    side,
    revision,
    name,
    at: now,
  };

  if (boosted) {
    s.boosts[m.date][uid] = mid;
  } else if (old === mid) {
    delete s.boosts[m.date][uid];
  }

  delete s.drafts[mid]?.[uid];
}

function rankings(s, range) {
  const users = new Map();

  for (const m of Object.values(s.matches)) {
    if (
      m.status === 'deleted' ||
      (range.start && m.date < range.start) ||
      (range.end && m.date > range.end)
    ) {
      continue;
    }

    for (const [uid, v] of Object.entries(
      s.votes[m.id] || {}
    )) {
      if (v.revision !== m.revision) continue;

      const r = users.get(uid) || {
        uid,
        name: v.name || uid,
        points: 0,
        wins: 0,
        boostedWins: 0,
        picks: 0,
      };

      r.picks++;
      r.name = v.name || r.name;

      if (m.result === v.side) {
        const boost =
          s.boosts[m.date]?.[uid] === m.id;

        r.points += boost ? 4 : 2;
        r.wins++;

        if (boost) r.boostedWins++;
      }

      users.set(uid, r);
    }
  }

  const result = [...users.values()].sort((a, b) =>
    b.points - a.points ||
    b.wins - a.wins ||
    b.boostedWins - a.boostedWins ||
    a.uid.localeCompare(b.uid)
  );

  result.forEach((r, n) => {
    const prev = result[n - 1];

    const tied = prev &&
      r.points === prev.points &&
      r.wins === prev.wins &&
      r.boostedWins === prev.boostedWins;

    r.rank = tied ? prev.rank : n + 1;
  });

  return result;
}

function rangeOptions(options) {
  const period =
    options.getString('periode') ||
    'semaine';

  const start = options.getString('debut');
  const end = options.getString('fin');

  if (start || end) {
    need(
      start && end,
      'Pour une période personnalisée, renseigne debut ET fin.'
    );

    dateKey(start);
    dateKey(end);

    need(
      start <= end,
      'La date de début doit précéder la date de fin.'
    );

    return {
      start,
      end,
      label: `du ${start} au ${end}`,
    };
  }

  if (period === 'general') {
    return { label: 'général' };
  }

  const monday = weekKey(
    parisDate(Date.now())
  );

  return {
    start: monday,
    end: shiftDate(monday, 6),
    label: `du ${monday} au ${shiftDate(monday, 6)}`,
  };
}

function baseEmbed(title) {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle(title)
    .setFooter({
      text: 'GOAT Betclic | 2 points • Boost x2 • Heure de Paris',
    });
}

function media(m, e) {
  if (m.imageFile) {
    const name =
      `goat-${m.id}${path.extname(m.imageFile)}`;

    e.setImage(`attachment://${name}`);

    return {
      files: [
        new AttachmentBuilder(m.imageFile, {
          name,
        }),
      ],
    };
  }

  if (m.image) e.setImage(m.image);

  return {};
}

function publicCard(m) {
  const active =
    m.result === null &&
    Date.now() < m.closeAt;

  const e = baseEmbed(m.title)
    .setDescription([
      m.description
        ? safe(m.description)
        : 'Qui va gagner ce match ? Fais ton choix !',
      '',
      `🏀 **${safe(m.home)}** | cote **${fmtOdd(m.homeOdds)}**`,
      `🏀 **${safe(m.away)}** | cote **${fmtOdd(m.awayOdds)}**`,
      '',
      `📅 Journée : **${m.date}**`,
      `🔒 Fermeture : **${formatTime(m.closeAt)}**, heure de Paris`,
      '',
      '**Bon choix : 2 points. Avec le boost : 4 points.**',
      'Un seul boost par journée. Clique sur une équipe puis valide ton choix.',
      'Les cotes sont indicatives et ne multiplient pas les points.',
      m.result === 'void'
        ? '\nMatch annulé : aucun point.'
        : ['home', 'away'].includes(m.result)
          ? `\n✅ Gagnant : **${safe(
            m.result === 'home' ? m.home : m.away
          )}**`
          : '',
    ].filter(Boolean).join('\n'))
    .setFooter({
      text: `GOAT Betclic | Match ${m.id}`,
    });

  return {
    embeds: [e],
    ...media(m, e),
    components: [
      row(
        btn(
          `pick:${m.id}:home:${m.revision}`,
          m.home,
          ButtonStyle.Primary,
          !active
        ),
        btn(
          `pick:${m.id}:away:${m.revision}`,
          m.away,
          ButtonStyle.Primary,
          !active
        ),
        btn(
          `my:${m.id}`,
          '📋 Mon choix'
        ),
        btn(
          `rank:${weekKey(m.date)}:${shiftDate(weekKey(m.date), 6)}:0`,
          '🏆 Classement'
        )
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function pickPreview(s, m, uid) {
  const d = s.drafts[m.id]?.[uid];

  need(
    d,
    'Reprends ton choix sur le message du match.'
  );

  const old = s.boosts[m.date]?.[uid];

  const e = baseEmbed('📋 Valide ton pronostic')
    .setDescription([
      `**${safe(m.home)} / ${safe(m.away)}**`,
      `Ton choix : **${safe(
        d.side === 'home' ? m.home : m.away
      )}**`,
      d.boost
        ? '⚡ Boost x2 sélectionné : **4 points** si tu as juste.'
        : '🎯 **2 points** si tu as juste.',
      `🔒 Fermeture : ${formatTime(m.closeAt)}`,
      old && old !== m.id && d.boost
        ? '\nTon boost sera déplacé de ton autre match vers celui-ci.'
        : '',
      '\nClique sur **Valider** pour enregistrer. Tu pourras modifier avant la fermeture.',
    ].filter(Boolean).join('\n'));

  return {
    content: '',
    embeds: [e],
    components: [
      row(
        btn(
          `validate:${m.id}:${d.revision}:${d.version}`,
          '✅ Valider',
          ButtonStyle.Success
        ),
        btn(
          `boost:${m.id}`,
          d.boost
            ? 'Retirer le boost'
            : '⚡ Boost x2'
        ),
        btn(
          `pick:${m.id}:home:${m.revision}`,
          m.home
        ),
        btn(
          `pick:${m.id}:away:${m.revision}`,
          m.away
        )
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function rankCard(s, range, page = 0) {
  const values = rankings(s, range);

  const pages = Math.max(
    1,
    Math.ceil(values.length / 15)
  );

  page = Math.max(
    0,
    Math.min(Number(page) || 0, pages - 1)
  );

  const pending = Object.values(s.matches)
    .filter(m =>
      m.status !== 'deleted' &&
      (!range.start || m.date >= range.start) &&
      (!range.end || m.date <= range.end) &&
      m.result === null
    ).length;

  const e = baseEmbed(
    `🏆 GOAT Betclic | Classement ${range.label}`
  )
    .setDescription(
      values
        .slice(page * 15, page * 15 + 15)
        .map(r =>
          `**${r.rank}.** <@${r.uid}> | **${r.points} pts** | ${r.wins} bons choix`
        )
        .join('\n') ||
      'Aucun pronostic validé sur cette période.'
    )
    .addFields(
      {
        name: pending
          ? '⏳ Provisoire'
          : '✅ Résultats saisis',
        value: pending
          ? `${pending} résultat(s) encore à saisir.`
          : 'Tous les résultats enregistrés sont saisis.',
      },
      {
        name: 'Égalités',
        value: 'Points, puis bons choix, puis boosts gagnants. Si tout est identique, les membres restent ex æquo.',
      }
    )
    .setFooter({
      text: `GOAT Betclic | Page ${page + 1}/${pages}`,
    });

  return {
    content: '',
    embeds: [e],
    components: [
      row(
        btn(
          `rank:${range.start || 'all'}:${range.end || 'all'}:${page - 1}`,
          '←',
          ButtonStyle.Secondary,
          page === 0
        ),
        btn(
          `rank:${range.start || 'all'}:${range.end || 'all'}:${page + 1}`,
          '→',
          ButtonStyle.Secondary,
          page === pages - 1
        )
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function listCard(s, date, page = 0) {
  const values = Object.values(s.matches)
    .filter(m =>
      m.status !== 'deleted' &&
      (!date || m.date === date)
    )
    .sort((a, b) =>
      b.date.localeCompare(a.date) ||
      a.publishAt - b.publishAt
    );

  const pages = Math.max(
    1,
    Math.ceil(values.length / 8)
  );

  page = Math.max(
    0,
    Math.min(Number(page) || 0, pages - 1)
  );

  const e = baseEmbed(
    date
      ? `📅 Matchs du ${date}`
      : '📅 GOAT Betclic | Matchs'
  )
    .setDescription(
      values
        .slice(page * 8, page * 8 + 8)
        .map(m =>
          `**${safe(m.home)} / ${safe(m.away)}**\n` +
          `ID : \`${m.id}\` | ${m.status}\n` +
          `Publication : ${formatTime(m.publishAt)}\n` +
          `Fermeture : ${formatTime(m.closeAt)} | <#${m.channelId}>`
        )
        .join('\n\n') ||
      'Aucun match. Utilise /goat create-match.'
    )
    .setFooter({
      text: `GOAT Betclic | Page ${page + 1}/${pages}`,
    });

  return {
    embeds: [e],
    components: [
      row(
        btn(
          `list:${date || 'all'}:${page - 1}`,
          '←',
          ButtonStyle.Secondary,
          page === 0
        ),
        btn(
          `list:${date || 'all'}:${page + 1}`,
          '→',
          ButtonStyle.Secondary,
          page === pages - 1
        )
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function addMatchOptions(s, edit = false) {
  if (edit) {
    s.addStringOption(o =>
      o.setName('id')
        .setDescription('ID du match dans /goat list')
        .setRequired(true)
    );
  }

  s.addStringOption(o =>
    o.setName('titre')
      .setDescription('Titre du message')
      .setMaxLength(200)
      .setRequired(!edit)
  )
    .addStringOption(o =>
      o.setName('equipe-a')
        .setDescription('Première équipe')
        .setMaxLength(70)
        .setRequired(!edit)
    )
    .addStringOption(o =>
      o.setName('equipe-b')
        .setDescription('Deuxième équipe')
        .setMaxLength(70)
        .setRequired(!edit)
    )
    .addNumberOption(o =>
      o.setName('cote-a')
        .setDescription('Cote Betclic de la première équipe')
        .setMinValue(1)
        .setMaxValue(10000)
        .setRequired(!edit)
    )
    .addNumberOption(o =>
      o.setName('cote-b')
        .setDescription('Cote Betclic de la deuxième équipe')
        .setMinValue(1)
        .setMaxValue(10000)
        .setRequired(!edit)
    )
    .addStringOption(o =>
      o.setName('publication')
        .setDescription(
          'Heure Paris : HH:mm AAAA-MM-JJ, exemple 07:00 2026-10-20'
        )
        .setRequired(!edit)
    )
    .addStringOption(o =>
      o.setName('fermeture')
        .setDescription(
          'Début du match, Paris : HH:mm AAAA-MM-JJ'
        )
        .setRequired(!edit)
    )
    .addChannelOption(o =>
      o.setName('salon')
        .setDescription('Salon de publication')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement
        )
        .setRequired(!edit)
    )
    .addStringOption(o =>
      o.setName('journee')
        .setDescription(
          'Date sportive AAAA-MM-JJ, sinon date de publication'
        )
    )
    .addStringOption(o =>
      o.setName('image')
        .setDescription(
          'URL de l’image, copier le lien de l’image'
        )
        .setMaxLength(1000)
    )
    .addStringOption(o =>
      o.setName('texte')
        .setDescription('Présentation facultative')
        .setMaxLength(1500)
    )
    .addRoleOption(o =>
      o.setName('notification')
        .setDescription('Rôle à notifier, facultatif')
    );

  if (edit) {
    s.addBooleanOption(o =>
      o.setName('retirer-image')
        .setDescription('Retirer l’image')
    )
      .addBooleanOption(o =>
        o.setName('retirer-notification')
          .setDescription('Retirer le rôle de notification')
      )
      .addBooleanOption(o =>
        o.setName('effacer-choix')
          .setDescription(
            'Autoriser le remplacement des équipes en effaçant les choix, avec confirmation'
          )
      );
  }

  return s;
}

function addRangeOptions(s) {
  return s.addStringOption(o =>
    o.setName('periode')
      .setDescription('Semaine actuelle ou classement général')
      .addChoices(
        {
          name: 'Semaine actuelle',
          value: 'semaine',
        },
        {
          name: 'Général',
          value: 'general',
        }
      )
  )
    .addStringOption(o =>
      o.setName('debut')
        .setDescription('Début personnalisé : AAAA-MM-JJ')
    )
    .addStringOption(o =>
      o.setName('fin')
        .setDescription('Fin personnalisée : AAAA-MM-JJ')
    );
}

const command = new SlashCommandBuilder()
  .setName('goat')
  .setDescription(
    'GOAT Betclic : matchs, résultats et classements'
  )
  .addSubcommand(s =>
    addMatchOptions(
      s.setName('create-match')
        .setDescription(
          'Créer et programmer un match en une seule commande'
        )
    )
  )
  .addSubcommand(s =>
    addMatchOptions(
      s.setName('edit-match')
        .setDescription(
          'Modifier un match programmé ou publié'
        ),
      true
    )
  )
  .addSubcommand(s =>
    s.setName('delete-match')
      .setDescription(
        'Supprimer un match avec confirmation'
      )
      .addStringOption(o =>
        o.setName('id')
          .setDescription('ID du match')
          .setRequired(true)
      )
  )
  .addSubcommand(s =>
    s.setName('set-result')
      .setDescription('Saisir ou corriger un résultat')
      .addStringOption(o =>
        o.setName('id')
          .setDescription('ID du match')
          .setRequired(true)
      )
      .addStringOption(o =>
        o.setName('gagnant')
          .setDescription('Résultat')
          .setRequired(true)
          .addChoices(
            {
              name: 'Équipe A',
              value: 'home',
            },
            {
              name: 'Équipe B',
              value: 'away',
            },
            {
              name: 'Annulé',
              value: 'void',
            },
            {
              name: 'En attente',
              value: 'pending',
            }
          )
      )
  )
  .addSubcommand(s =>
    addRangeOptions(
      s.setName('leaderboard')
        .setDescription(
          'Afficher le classement uniquement sur demande'
        )
    )
  )
  .addSubcommand(s =>
    addRangeOptions(
      s.setName('export')
        .setDescription(
          'Exporter les points et les pronostics en CSV'
        )
    )
  )
  .addSubcommand(s =>
    s.setName('list')
      .setDescription(
        'Voir les matchs et leurs identifiants'
      )
  )
  .addSubcommand(s =>
    s.setName('day')
      .setDescription('Voir les matchs d’une journée')
      .addStringOption(o =>
        o.setName('date')
          .setDescription('AAAA-MM-JJ')
          .setRequired(true)
      )
  )
  .addSubcommand(s =>
    s.setName('diagnostic')
      .setDescription(
        'Vérifier la sauvegarde et les programmations'
      )
  );

// Les liens d'images Discord expirent.
// Les images Discord sont copiées sur le volume.
async function cacheImage(m, directory) {
  m.imageFile = '';

  if (!m.image) return;

  const url = new URL(m.image);

  if (![
    'cdn.discordapp.com',
    'media.discordapp.net',
  ].includes(url.hostname)) {
    return;
  }

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });

  need(
    response.ok,
    'Impossible de récupérer cette image Discord. Recopie un lien récent.'
  );

  const type = response.headers
    .get('content-type')
    ?.split(';')[0];

  const ext = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[type];

  need(
    ext,
    'Utilise une image PNG, JPG, WEBP ou GIF.'
  );

  need(
    Number(
      response.headers.get('content-length') || 0
    ) <= 8 * 1024 * 1024,
    'Image trop lourde : maximum 8 Mo.'
  );

  const chunks = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.length;

    need(
      size <= 8 * 1024 * 1024,
      'Image trop lourde : maximum 8 Mo.'
    );

    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  const folder = path.join(directory, 'images');

  await fs.mkdir(folder, {
    recursive: true,
  });

  const hash = createHash('sha256')
    .update(buffer)
    .digest('hex')
    .slice(0, 16);

  const imagePath = path.join(
    folder,
    `${m.id}-${hash}${ext}`
  );

  await fs.writeFile(imagePath, buffer, {
    mode: 0o600,
  });

  m.imageFile = imagePath;
}

async function run() {
  const env = process.env;
  const guildId = env.DISCORD_GUILD_ID?.trim();

  need(
    env.DISCORD_TOKEN &&
    /^\d{17,20}$/.test(guildId || ''),
    'Renseigne DISCORD_TOKEN et DISCORD_GUILD_ID.'
  );

  const admins = new Set(
    (env.ADMIN_USER_IDS || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
  );

  need(
    admins.size &&
    [...admins].every(x => /^\d{17,20}$/.test(x)),
    'Renseigne ADMIN_USER_IDS avec vos IDs Discord.'
  );

  const store = createStore(env);
  await store.init();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const quiet = { parse: [] };
  const privateFlag = MessageFlags.Ephemeral;

  let ticking = false;
  let stopping = false;
  let timer;

  const log = (label, e) => console.error(
    `${label}: ${e?.code || e?.name || 'Erreur'}`
  );

  function admin(i) {
    need(
      i.guildId === guildId &&
      admins.has(i.user.id),
      'Cette action est réservée à l’équipe autorisée.'
    );
  }

  async function channel(cid) {
    const c = await client.channels.fetch(cid);

    need(
      c &&
      c.guildId === guildId &&
      [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
      ].includes(c.type),
      'Salon inaccessible.'
    );

    need(
      c.permissionsFor(client.user)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ]),
      'Le bot doit pouvoir voir le salon, lire l’historique, envoyer des messages, des liens et des fichiers.'
    );

    return c;
  }

  async function recover(c, m) {
    if (m.post?.id) {
      try {
        return await c.messages.fetch(m.post.id);
      } catch (e) {
        if (e.code !== 10008) throw e;
        return null;
      }
    }

    if (!m.sendStartedAt) return null;

    let before;

    for (let n = 0; n < 100; n++) {
      const messages = await c.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!messages.size) return null;

      const found = messages.find(x =>
        x.author.id === client.user.id &&
        x.embeds.some(e =>
          e.footer?.text ===
          `GOAT Betclic | Match ${m.id}`
        )
      );

      if (found) return found;

      const last = messages.last();

      if (
        last.createdTimestamp <
        m.sendStartedAt - 10000
      ) {
        return null;
      }

      before = last.id;
    }

    throw new Error(
      'Impossible de vérifier l’historique avant publication.'
    );
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
      const s = await store.read();

      const matches = Object.values(s.matches)
        .sort((a, b) => a.publishAt - b.publishAt);

      for (const m of matches) {
        if (m.status === 'deleted') {
          if (m.post?.id) {
            try {
              const c = await channel(
                m.post.channelId
              );

              const msg = await recover(c, m);

              if (msg) await msg.delete();

              await store.change(x => {
                x.matches[m.id].post = null;
              });
            } catch (e) {
              log('Suppression message', e);
            }
          }

          continue;
        }

        const active =
          m.result === null &&
          Date.now() < m.closeAt;

        const scheduled =
          m.status === 'scheduled' &&
          m.publishAt <= Date.now();

        const refresh =
          m.status === 'published' &&
          (
            m.dirty ||
            m.lastOpen !== active
          );

        if (!scheduled && !refresh) continue;

        try {
          let target = m;

          if (
            m.post &&
            m.post.channelId !== m.channelId
          ) {
            const oldChannel = await channel(
              m.post.channelId
            );

            const old = await recover(
              oldChannel,
              m
            );

            if (old) await old.delete();

            await store.change(x => {
              x.matches[m.id].post = null;
              x.matches[m.id].sendStartedAt = null;
            });

            target = {
              ...m,
              post: null,
              sendStartedAt: null,
            };
          }

          const c = await channel(m.channelId);
          const old = await recover(c, target);
          const payload = publicCard(m);

          let sent;

          if (old) {
            sent = await old.edit({
              ...payload,
              attachments: [],
              content: '',
              allowedMentions: quiet,
            });
          } else {
            if (!target.sendStartedAt) {
              target.sendStartedAt = Date.now();

              await store.change(x => {
                x.matches[m.id].sendStartedAt =
                  target.sendStartedAt;
              });
            }

            const nonce = BigInt(
              '0x' +
              createHash('sha256')
                .update(
                  `${m.id}:${target.sendStartedAt}`
                )
                .digest('hex')
                .slice(0, 16)
            ).toString();

            sent = await c.send({
              ...payload,
              nonce,
              enforceNonce: true,
              content:
                m.status === 'scheduled' && m.roleId
                  ? `<@&${m.roleId}>`
                  : '',
              allowedMentions:
                m.status === 'scheduled' && m.roleId
                  ? {
                    parse: [],
                    roles: [m.roleId],
                  }
                  : quiet,
            });
          }

          const deleted = await store.change(x => {
            const latest = x.matches[m.id];

            latest.post = {
              id: sent.id,
              channelId: m.channelId,
            };

            if (latest.status === 'deleted') {
              return true;
            }

            latest.status = 'published';
            latest.lastOpen = active;

            if (latest.version === m.version) {
              latest.dirty = false;
            }

            return false;
          });

          if (deleted) {
            await sent.delete();

            await store.change(x => {
              x.matches[m.id].post = null;
            });
          }
        } catch (e) {
          log(`Publication ${m.id}`, e);
        }
      }

      // Aucun classement automatique.
    } catch (e) {
      log('Programmation', e);
    } finally {
      ticking = false;
    }
  }

  async function pending(i, action) {
    const token = id();

    await store.change(s => {
      s.pending[token] = {
        ...action,
        uid: i.user.id,
        expires: Date.now() + 15 * 60000,
      };
    });

    return i.editReply({
      content: action.kind === 'delete'
        ? '⚠️ Supprimer ce match et son message ? Ses points seront retirés du classement. Une copie sera archivée.'
        : '⚠️ Remplacer ces équipes ou cette journée effacera les choix et le boost sur ce match. Confirmer ?',
      embeds: [],
      components: [
        row(
          btn(
            `admin-confirm:${token}`,
            'Confirmer',
            ButtonStyle.Danger
          ),
          btn(
            `admin-cancel:${token}`,
            'Annuler'
          )
        ),
      ],
      allowedMentions: quiet,
    });
  }

  async function slash(i) {
    need(
      i.guildId === guildId,
      'Utilise cette commande sur le serveur configuré.'
    );

    const sub = i.options.getSubcommand();

    if (sub !== 'leaderboard') {
      admin(i);
    }

    await i.deferReply({
      flags: sub === 'leaderboard'
        ? undefined
        : privateFlag,
    });

    if (
      sub === 'create-match' ||
      sub === 'edit-match'
    ) {
      const o = i.options;
      const editing = sub === 'edit-match';

      const before = editing
        ? match(
          await store.read(),
          o.getString('id')
        )
        : null;

      const m = before
        ? structuredClone(before)
        : {
          id: id(),
          status: 'scheduled',
          result: null,
          revision: 1,
          version: 1,
          post: null,
          dirty: true,
          createdAt: Date.now(),
          description: '',
          image: '',
          imageFile: '',
          roleId: null,
        };

      const strings = {
        titre: 'title',
        'equipe-a': 'home',
        'equipe-b': 'away',
        texte: 'description',
        image: 'image',
        journee: 'date',
      };

      for (const [key, prop] of Object.entries(strings)) {
        const v = o.getString(key);

        if (v !== null) m[prop] = v;
      }

      for (const [key, prop] of [
        ['cote-a', 'homeOdds'],
        ['cote-b', 'awayOdds'],
      ]) {
        const v = o.getNumber(key);

        if (v !== null) m[prop] = v;
      }

      if (o.getString('publication')) {
        m.publishAt = parseTime(
          o.getString('publication')
        );
      }

      if (o.getString('fermeture')) {
        m.closeAt = parseTime(
          o.getString('fermeture')
        );
      }

      if (o.getChannel('salon')) {
        m.channelId = o.getChannel('salon').id;
      }

      if (o.getRole('notification')) {
        m.roleId = o.getRole('notification').id;
      }

      if (
        editing &&
        o.getBoolean('retirer-image')
      ) {
        m.image = '';
        m.imageFile = '';
      }

      if (
        editing &&
        o.getBoolean('retirer-notification')
      ) {
        m.roleId = null;
      }

      if (!m.date) {
        m.date = parisDate(m.publishAt);
      }

      // Une clôture passée ne peut pas être rouverte.
      if (
        before?.status === 'published' &&
        Date.now() >= before.closeAt
      ) {
        m.closeAt = Math.min(
          m.closeAt,
          before.closeAt
        );
      }

      validate(m);
      await channel(m.channelId);

      if (!editing) {
        need(
          m.publishAt > Date.now(),
          'Choisis une publication dans le futur.'
        );
      }

      if (
        !before ||
        before.status !== 'published'
      ) {
        need(
          m.closeAt > Date.now(),
          'La fermeture doit être dans le futur.'
        );
      }

      if (
        !before ||
        before.image !== m.image
      ) {
        await cacheImage(m, store.directory);
      }

      const sensitive = before && (
        before.home !== m.home ||
        before.away !== m.away ||
        before.date !== m.date
      );

      const state = await store.read();

      const hasChoices = Object.keys(
        state.votes[m.id] || {}
      ).length > 0;

      if (sensitive && hasChoices) {
        need(
          o.getBoolean('effacer-choix'),
          'Des choix existent. Ajoute effacer-choix:true pour remplacer les équipes ou la journée, avec confirmation.'
        );

        return pending(i, {
          kind: 'edit',
          mid: m.id,
          version: before.version,
          data: m,
        });
      }

      await store.change(s => {
        if (before) {
          const current = match(s, m.id);

          need(
            current.version === before.version,
            'Le match a changé. Recommence la modification.'
          );

          if (sensitive) {
            clearChoices(s, current);
          }

          m.revision = current.revision;
          m.result = current.result;
          m.status = current.status;
          m.post = current.post;
          m.sendStartedAt = current.sendStartedAt;
          m.version = current.version + 1;
        }

        m.dirty = true;
        s.matches[m.id] = m;

        audit(s, i.user.id, sub, m.id);
      });

      void tick();

      return i.editReply({
        content:
          `✅ ${editing ? 'Match modifié' : 'Match créé et programmé'}.\n` +
          `**ID :** \`${m.id}\`\n` +
          `**${safe(m.title)}**\n` +
          `${safe(m.home)} (${fmtOdd(m.homeOdds)}) / ` +
          `${safe(m.away)} (${fmtOdd(m.awayOdds)})\n` +
          `Publication : **${formatTime(m.publishAt)}**\n` +
          `Fermeture : **${formatTime(m.closeAt)}**\n` +
          `Salon : <#${m.channelId}>\n` +
          `Journée du boost et des points : **${m.date}**`,
        allowedMentions: quiet,
      });
    }

    const s = await store.read();

    if (sub === 'delete-match') {
      const m = match(
        s,
        i.options.getString('id')
      );

      return pending(i, {
        kind: 'delete',
        mid: m.id,
        version: m.version,
      });
    }

    if (sub === 'set-result') {
      const mid = i.options.getString('id');
      const result = i.options.getString('gagnant');

      await store.change(x => {
        const m = match(x, mid);

        need(
          result === 'pending' ||
          result === 'void' ||
          Date.now() >= m.closeAt,
          'Le match n’a pas encore commencé.'
        );

        m.result = result === 'pending'
          ? null
          : result;

        m.dirty = true;
        m.version++;

        audit(x, i.user.id, sub, mid);
      });

      void tick();

      return i.editReply(
        '✅ Résultat enregistré. Les points sont recalculés, sans publication automatique de classement.'
      );
    }

    if (sub === 'leaderboard') {
      return i.editReply(
        rankCard(s, rangeOptions(i.options))
      );
    }

    if (sub === 'list' || sub === 'day') {
      const date = sub === 'day'
        ? dateKey(i.options.getString('date'))
        : null;

      return i.editReply(listCard(s, date));
    }

    if (sub === 'diagnostic') {
      const all = Object.values(s.matches)
        .filter(m => m.status !== 'deleted');

      return i.editReply([
        `✅ Sauvegarde : ${store.filename}`,
        `📅 ${all.filter(m => m.status === 'scheduled').length} matchs programmés`,
        `📣 ${all.filter(m => m.status === 'published').length} matchs publiés`,
        `⏳ ${all.filter(m => m.result === null && m.closeAt < Date.now()).length} résultats à saisir`,
        '🏆 Classements uniquement sur commande',
        '🕰 Heure de Paris',
        `📦 ${s.archives.length} archives`,
      ].join('\n'));
    }

    if (sub === 'export') {
      const range = rangeOptions(i.options);
      const values = rankings(s, range);

      const csv = v =>
        `"${String(v ?? '')
          .replaceAll('"', '""')
          .replace(/^[=+\-@]/, "'$&")}"`;

      const rows = [[
        'date',
        'match_id',
        'discord_id',
        'pseudo',
        'equipe_a',
        'equipe_b',
        'choix',
        'boost',
        'resultat',
        'points',
      ]];

      for (const m of Object.values(s.matches)) {
        if (
          m.status === 'deleted' ||
          (range.start && m.date < range.start) ||
          (range.end && m.date > range.end)
        ) {
          continue;
        }

        for (const [uid, v] of Object.entries(
          s.votes[m.id] || {}
        )) {
          if (v.revision !== m.revision) continue;

          const boost =
            s.boosts[m.date]?.[uid] === m.id;

          rows.push([
            m.date,
            m.id,
            uid,
            v.name,
            m.home,
            m.away,
            v.side === 'home' ? m.home : m.away,
            boost ? 'oui' : 'non',
            m.result || 'en attente',
            m.result === v.side
              ? (boost ? 4 : 2)
              : 0,
          ]);
        }
      }

      const standings = [
        [
          'rang',
          'discord_id',
          'pseudo',
          'points',
          'bons_choix',
          'boosts_gagnants',
        ],
        ...values.map(v => [
          v.rank,
          v.uid,
          v.name,
          v.points,
          v.wins,
          v.boostedWins,
        ]),
      ];

      const file = (data, name) =>
        new AttachmentBuilder(
          Buffer.from(
            '\uFEFF' +
            data
              .map(r => r.map(csv).join(';'))
              .join('\r\n')
          ),
          { name }
        );

      return i.editReply({
        content: `📁 Export ${range.label}`,
        files: [
          file(rows, 'pronostics.csv'),
          file(standings, 'classement.csv'),
        ],
      });
    }
  }

  async function buttons(i) {
    need(
      i.guildId === guildId,
      'Serveur invalide.'
    );

    const [action, mid, side, rev] =
      i.customId.split(':');

    if (i.message.flags.has(privateFlag)) {
      await i.deferUpdate();
    } else {
      await i.deferReply({
        flags: privateFlag,
      });
    }

    if (action.startsWith('admin-')) {
      admin(i);

      const token = mid;

      await store.change(s => {
        const p = s.pending[token];

        need(
          p &&
          p.uid === i.user.id &&
          p.expires > Date.now(),
          'Confirmation expirée. Recommence la commande.'
        );

        if (action === 'admin-confirm') {
          const m = match(s, p.mid);

          need(
            m.version === p.version,
            'Ce match a changé : recommence la commande.'
          );

          if (p.kind === 'delete') {
            s.archives.push({
              action: 'suppression',
              at: Date.now(),
              match: structuredClone(m),
              votes: structuredClone(
                s.votes[m.id] || {}
              ),
            });

            clearChoices(s, m);
            m.status = 'deleted';
            m.version++;
          } else {
            clearChoices(s, m);

            Object.assign(m, p.data, {
              revision: m.revision,
              version: m.version + 1,
              result: null,
              dirty: true,
            });
          }

          audit(
            s,
            i.user.id,
            p.kind,
            p.mid
          );
        }

        delete s.pending[token];
      });

      void tick();

      return i.editReply({
        content: action === 'admin-confirm'
          ? '✅ Modification confirmée.'
          : 'Modification annulée.',
        embeds: [],
        components: [],
      });
    }

    if (action === 'rank') {
      const [, start, end, page] =
        i.customId.split(':');

      const range = start === 'all'
        ? { label: 'général' }
        : {
          start,
          end,
          label: `du ${start} au ${end}`,
        };

      return i.editReply(
        rankCard(
          await store.read(),
          range,
          page
        )
      );
    }

    if (action === 'list') {
      admin(i);

      return i.editReply(
        listCard(
          await store.read(),
          mid === 'all' ? null : mid,
          side
        )
      );
    }

    // Compatibilité avec les anciens messages.
    if (['play', 'summary'].includes(action)) {
      const s = await store.read();
      const legacy = s.legacyDays?.[mid]?.[0];

      need(
        legacy,
        'Utilise les boutons du nouveau message du match.'
      );

      const m = match(s, legacy);

      return i.editReply({
        ...publicCard(m),
        content: 'Choisis une équipe pour ce match.',
      });
    }

    if (action === 'my') {
      const s = await store.read();
      const m = match(s, mid);
      const v = s.votes[mid]?.[i.user.id];

      const boosted =
        s.boosts[m.date]?.[i.user.id] === mid;

      return i.editReply({
        content: v
          ? (
            `✅ Ton choix validé : **${safe(
              v.side === 'home' ? m.home : m.away
            )}**${boosted ? ' ⚡ Boost x2' : ''}\n` +
            'Pour le modifier avant la fermeture, clique à nouveau sur une équipe.'
          )
          : 'Tu n’as pas encore validé de choix. Clique sur une équipe puis sur Valider.',
        embeds: [],
        components: [],
        allowedMentions: quiet,
      });
    }

    if (
      action === 'pick' ||
      action === 'boost'
    ) {
      const s = await store.change(x => {
        const m = match(x, mid);

        need(
          available(m),
          'Ce match est fermé.'
        );

        x.drafts[mid] ||= {};

        if (action === 'pick') {
          need(
            m.revision === Number(rev),
            'Le match a changé. Utilise son message actualisé.'
          );

          need(
            ['home', 'away'].includes(side),
            'Choix invalide.'
          );

          x.drafts[mid][i.user.id] = {
            side,
            revision: m.revision,
            boost:
              x.drafts[mid][i.user.id]?.boost ??
              (
                x.boosts[m.date]?.[i.user.id] === mid
              ),
            version:
              (
                x.drafts[mid][i.user.id]?.version ||
                0
              ) + 1,
          };
        } else {
          const d = x.drafts[mid][i.user.id];

          need(
            d,
            'Choisis une équipe avant de booster.'
          );

          d.boost = !d.boost;
          d.version++;
        }

        return x;
      });

      return i.editReply(
        pickPreview(
          s,
          match(s, mid),
          i.user.id
        )
      );
    }

    if (action === 'validate') {
      await store.change(s => {
        const m = match(s, mid);
        const d = s.drafts[mid]?.[i.user.id];

        need(
          d &&
          d.revision === Number(side) &&
          d.version === Number(rev),
          'Ton choix a changé. Reprends le récapitulatif avant de valider.'
        );

        confirmPick(
          s,
          mid,
          i.user.id,
          d.side,
          d.boost,
          d.revision,
          i.member?.displayName ||
          i.user.globalName ||
          i.user.username
        );
      });

      const s = await store.read();
      const m = match(s, mid);
      const v = s.votes[mid][i.user.id];

      const boosted =
        s.boosts[m.date]?.[i.user.id] === mid;

      return i.editReply({
        content:
          `✅ Pronostic validé : **${safe(
            v.side === 'home' ? m.home : m.away
          )}**${boosted ? ' ⚡ Boost x2' : ''}\n` +
          'Tu peux conserver ce choix ou cliquer sur une autre équipe pour le modifier avant la fermeture.',
        embeds: [],
        components: [
          row(
            btn(
              `pick:${mid}:home:${m.revision}`,
              m.home
            ),
            btn(
              `pick:${mid}:away:${m.revision}`,
              m.away
            )
          ),
        ],
        allowedMentions: quiet,
      });
    }
  }

  client.on(Events.InteractionCreate, async i => {
    if (stopping) return;

    try {
      if (
        i.isChatInputCommand() &&
        i.commandName === 'goat'
      ) {
        await slash(i);
      } else if (
        i.isButton() &&
        /^(pick|boost|validate|my|rank|list|admin-confirm|admin-cancel|play|summary):/
          .test(i.customId)
      ) {
        await buttons(i);
      }
    } catch (e) {
      if (!(e instanceof UserError)) {
        log('Interaction', e);
      }

      const payload = {
        content: e instanceof UserError
          ? `⚠️ ${e.message}`
          : 'Une erreur est survenue. Les données déjà sauvegardées sont conservées.',
        flags: privateFlag,
        allowedMentions: quiet,
      };

      try {
        if (i.deferred || i.replied) {
          await i.followUp(payload);
        } else {
          await i.reply(payload);
        }
      } catch (err) {
        log('Réponse erreur', err);
      }
    }
  });

  client.on(
    Events.Error,
    e => log('Discord', e)
  );

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);

      // Nettoyer les anciennes commandes de ce bot.
      const previous = await guild.commands.fetch();

      for (const c of previous.values()) {
        if (c.name === 'goat-admin') {
          await guild.commands.delete(c.id);
        }
      }

      const globals =
        await client.application.commands.fetch();

      for (const c of globals.values()) {
        if (['goat', 'goat-admin'].includes(c.name)) {
          await client.application.commands.delete(c.id);
        }
      }

      await guild.commands.create(
        command.toJSON()
      );

      console.log(
        'GOAT Betclic prêt. Commandes simplifiées. Stockage sur volume.'
      );

      await tick();

      timer = setInterval(
        () => void tick(),
        15000
      );
    } catch (e) {
      log('Initialisation', e);
      void stop(1);
    }
  });

  async function stop(code = 0) {
    if (stopping) return;

    stopping = true;
    clearInterval(timer);
    client.destroy();

    await store.close().catch(() => {});

    process.exit(code);
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(
      sig,
      () => void stop()
    );
  }

  process.once('uncaughtException', e => {
    log('Erreur fatale', e);
    void stop(1);
  });

  process.once('unhandledRejection', e => {
    log('Erreur fatale', e);
    void stop(1);
  });

  await client.login(env.DISCORD_TOKEN);
}

if (require.main === module) {
  run().catch(e => {
    console.error(
      `Démarrage : ${
        e instanceof UserError
          ? e.message
          : e.code || e.name
      }`
    );

    process.exitCode = 1;
  });
} else {
  module.exports = {
    initialState,
    migrate,
    validate,
    confirmPick,
    rankings,
    Store,
    parseTime,
    parisDate,
    weekKey,
    shiftDate,
    command,
    publicCard,
    pickPreview,
    rankCard,
    listCard,
  };
}
