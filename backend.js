module.exports = call;

const   shortid = require('shortid'),
         uuidv4 = require('uuid/v4'),
         bcrypt = require('bcryptjs'),
    levenshtein = require('js-levenshtein'),
             fs = require('fs');
             lo = require('lodash'),
          lowdb = require('lowdb'),
        msgpack = require('what-the-pack').initialize(2 ** 24 /* = 16 MiB */),
          https = require('https'),
  color_convert = require('color-convert'),
       announce = require('./announce.js');

require('object.fromentries').shim();

const ROUND_NO = 8;
const deburr = s => s.normalize('NFD').replace(/\u0131/g, 'i').replace(/[\u0300-\u030f]/g, '').replace(/[^0-9A-Za-z_-]+/g, ' ').toLowerCase();

const BaseAdapter = require('lowdb/adapters/Base');
class OurAdapter extends BaseAdapter {
  read() {
    let buf;
    try {
      buf = fs.readFileSync(this.source);
    } catch(e) {
      process.stderr.write(`\u001b[1;91mNote: setting the default value for ${this.source} because of a file read failure\u001b[0m\n`);
      this.write(this.defaultValue);
      return this.defaultValue;
    }
    let o;
    try {
      o = JSON.parse(buf.toString());
    } catch(e) {
      o = msgpack.decode(buf);
    }
    return o;
  }
  write(data) {
    fs.writeFileSync(this.source, msgpack.encode(data));
  }
}

const db = lowdb(new OurAdapter(    'dict.db',
                 {defaultValue: {entries: {},  count: 0 }})),
    pass = lowdb(new OurAdapter('accounts.db',
                 {defaultValue: { hashes: {}, tokens: {}}}));

call.db = db;
call.pass = pass;
call.call = call;
call.replacements = replacements;

let actions = {};

const flip = e => ({success: false, error: e});
const good = d => ({success: true,  ...d});

call.score = score;
function score(entry) {
  return Object.entries(entry.votes)
    .reduce((a, b) => a + b[1], 0);
}

function present(entry, id, uname) {
  let e = {...entry, id};
  if(uname) e.vote = e.votes[uname] || 0;
  delete e.votes; delete e._head; delete e._content;
  return e;
}

function guard(logged_in, conds, f) {
  return (ret, i, uname) => {
    if(logged_in && ! uname)
      return ret(flip('must be logged in'));
    if(conds) for([k, v] of Object.entries(conds)) {
      let err = v(i[k]);
      if(err !== true)
        return ret(flip(`error for field ${k}: ${err}`));
    }
    f(ret, i, uname);
  };
}
const checks = {
  present: i => !!i || 'absent',
    scope: i => !(i && typeof i == 'string') ? 'scope is not string' :
             !!i.match(/^[a-z-]{1,24}$/) || 'scope must match [a-z-]{1,24}',
  shortid: i => (i && shortid.isValid(i)) || 'not a valid ID',
    limit: lim => i => (!i || !typeof i == 'string') ? 'absent' :
             (i.length <= lim || `too long (max. ${lim} characters)`),
};
checks.nobomb = checks.limit(2048);

function author_color(name) {
  if(name === 'official')
    return 0x333333;
  var n = 0;
  for(var i = 0, l = name.length; i < l; ++i)
    n = (((n << 5) - n) + name.charCodeAt(i)) % 360;
  return Number.parseInt(color_convert.hsl.hex(n, 100, 30), 16);
}

// 7 days
const EXPIRY = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function call(i, ret, admin) {
  let action = actions.hasOwnProperty(i.action) && actions[i.action];
  if(! action) return ret(flip('unknown action'));
  let uname;
  if(admin) uname = admin;
  else if(i.token) {
    if(!typeof i.token == 'string' || !i.token.match(UUID))
      return ret(flip('token is not a valid UUID'));
    let token = pass.get('tokens').get(i.token).value();
    if(token) {
      uname = token.name;
      let now = +new Date;
      if(now > token.last + EXPIRY) {
        ret(flip('token has expired'));
        return pass.get('tokens').unset(i.token).write();
      } else
        pass.get('tokens').get(i.token)
          .set('last', now).write();
    }
  }
  try {
    action(ret, i, uname);
  } catch(e) {
    process.stderr.write(e.stack + '\n');
    ret(flip('internal error'));
  }
}

actions.whoami = guard(false, {}, (ret, i, uname) => {
  ret(good({
    data: uname /* || undefined */,
    count: db.get('count').value()
  }));
});

// not using a dictionary because it would mangle the RegExp objects.
// the second returned element of each entry – if it's an array – is
// the heaviness, i.e., how little time it takes to run the function
// on an entry multiplied by how far the function narrows down the
// search
const PATTERNS = [
  [/\|/, (_, __, s) => {
    let handlers = s.split('|').map(parse_term);
    let f = e => handlers.some(h => h(e));
    f.heaviness = handlers.reduce((o, _) => Math.max(_.heaviness, o), -Infinity) + 1;
    return f;
  }],
  [/^!(.*?)$/, (_, s) => {
    let h = parse_term(s);
    let f = e => ! h(e);
    f.heaviness = h.heaviness + 1;
    return f;
  }],
  [/[#@\/]/, (_, __, s) => {
    let handlers = s.split(/(?=[#@\/])/).map(part =>
      part.replace(/^[#@\/]/, s => ({ '#': 'id:', '@': 'user:', '/': 'arity:' }[s])))
      .map(parse_term);
    let f = e => handlers.every(h => h(e));
    f.heaviness = handlers.reduce((o, _) => _.heaviness + o, 1);
    return f;
  }],
  [/^(?:id:)([0-9A-Za-z-_]{6,})$/, (_, id)    => [e => e.id === id, -Infinity]],
  [/^(?:user:)([A-Za-z]{1,16})$/,  (_, user)  => [e => e.by === user, 0]],
  [/^(?:scope:)([a-z-]+)$/,        (_, scope) => [e => e.scope === scope, -Infinity]],
  [/^(?:arity:)([0-9]+)$/, (_, nstr) => {
    let n = parseInt(nstr, 10);
    let f = e => e.body.split(/[;.]/).map(_ => {
      let matches = _.match(/▯/g);
      return matches ? matches.length : -1;
    }).reduce((a, b) => Math.max(a, b), -1) == n;
    f.heaviness = 5;
    return f;
  }],
];

const whatever = e => true;
whatever.heaviness = Infinity;
function parse_term(term) {
  for([pat, fun] of PATTERNS) {
    let m = term.match(pat);
    if(m) {
      let f = fun(...m, m.index, m.input);
      if(f instanceof Array) {
        f[0].heaviness = f[1];
        f = f[0];
      }
      return f;
    }
  }
  let deburred = deburr(term);
  if(! deburred.length) return whatever;
  let deft = e => e._content.indexOf(deburred) !== -1;
  deft.heaviness = 255;
  deft.bare = deburred;
  return deft;
}

let cache;
actions.search = guard(false, {query: checks.present}, (ret, i, uname) => {
  let start = +new Date;
  let query = i.query.toString().split(' ').filter(_ => _);
  // each term of the query gets mapped to a filtering function
  let conds = lo(query.map(parse_term).filter(_ => _ != whatever))
    .sortBy('.heaviness').value();
  let bare_terms = conds.map(_ => _.bare).filter(_ => _);
  let filtered = conds.reduce((sofar, cond) => sofar.filter(cond), cache);
  let sorted = lo(filtered).sortBy([
    e =>
      - 6 * bare_terms.some(_ => e._content.indexOf(` ${_} `) != -1)
      - 6 * bare_terms.some(_ => e._head.indexOf(_) != -1)
      + 1 * bare_terms.reduce((_, term) => _ + 
        (e._head.indexOf(term) != -1) * levenshtein(term, e._head), 0)
      - 2 * e.score
      + 4 * (['oldofficial', 'oldexamples', 'oldcountries'].includes(e.by))
      + Math.exp((new Date() - new Date(e.on)) / (-1000 * 3600 * 24 * 7))
  ]);
  let data = sorted.value().map(_ => present(_, _.id, uname));
  process.stderr.write(`\u001b[37mapi.search:\u001b[0m query «\u001b[32m${
    i.query}\u001b[0m» took \u001b[1m${new Date - start}\u001b[0m ms\n`);
  ret(good({data}));
});

actions.info = guard(false, {id: checks.shortid}, (ret, i, uname) => {
  let res = cached(i.id);
  ret(res ? good({data: present(res, i.id, uname)})
          : flip('not found'));
});

// TODO: messy code
actions.vote = guard(true, {
  id: checks.shortid, vote: _ => [-1, 0, 1].includes(_)
}, (ret, i, uname) => {
  let e = db.get('entries').get(i.id);
  if(!e) return ret(flip('not found'));
  let ec = cached(i.id);
  let old_vote = ec.votes[uname] || 0;
  e.get('votes').set(uname, i.vote).write();
  // ec.votes[uname] = i.vote;
  ec.score += i.vote - old_vote;
  ret();
});

actions.note = guard(true, {
  id: checks.shortid, content: checks.nobomb
}, (ret, i, uname) => {
  let word = db.get('entries').get(i.id);
  if(word.value() == undefined)
    return ret(flip('word doesn\'t exist'));
  let this_note = {
    on: new Date().toISOString(),
    content: replacements(i.content),
    by: uname
  };
  word.get('notes')
    .push(this_note)
    .write();
  // Don't do this! The objects are semi-shallow copies! (for some reason)
  // // cached(i.id).notes.push(this_note);
  cached(i.id)._content += `${deburr(this_note.content)} `;
  word = word.value();
  announce({
    color: author_color(uname),
    fields: [{
      name: `(definition by *${word.by}*)`,
      value: word.body
    }],
    title: `*${uname}* noted on **${word.head}**`,
    description: this_note.content,
    url: `http://uakci.pl/toadua/#%23${i.id}`
  });
  ret();
});

// compat purposes
actions.comment = actions.note;

function replacements(s) {
  return s.replace(/___/g, '▯').replace(/[\n\r]+/g, '').normalize('NFC');
}

actions.create = guard(true, {
  head: checks.nobomb, body: checks.nobomb, scope: checks.scope
}, (ret, i, uname) => {
  let id = shortid.generate();
  let this_entry = {
    on: new Date().toISOString(),
    head: replacements(i.head), body: replacements(i.body),
    by: uname,
    scope: i.scope,
    notes: [],
    votes: {}
  };
  cache.push(cacheify(this_entry, id));
  ret(good({data: id}));
  db.get('entries').set(id, this_entry).write();
  announce({
    color: author_color(uname),
    title: `*${uname}* created **${i.head}**`,
    description: i.body.replace(/___/g, '\u25af'),
    url: `http://uakci.pl/toadua/#%23${id}`
  });
  db.set('count', Object.entries(db.get('entries').value()).length).write();
});

actions.login = guard(false, {
  name: checks.present, pass: checks.present
}, (ret, i) => {
  let expected = pass.get('hashes').get(i.name).value();
  if(!expected) return ret(flip('user not registered'));
  if(bcrypt.compareSync(i.pass, expected)) {
    var token = uuidv4();
    pass.get('tokens')
      .set(token, { name: i.name, last: +new Date })
      .write();
    ret(good({ token: token, name: i.name }));
  } else ret(flip('password doesn\'t match'));
});

actions.register = guard(false, {
  name: it => (it.match(/^[a-zA-Z]{1,64}$/) && true) || 'name must be 1-64 Latin characters',
  pass: checks.limit(128)
}, (ret, i) => {
  if(pass.get('hashes').get(i.name).value())
    return ret(flip('already registered'));
  pass.get('hashes')
    .set(i.name, bcrypt.hashSync(i.pass, ROUND_NO))
    .write();
  actions.login(ret, { name: i.name, pass: i.pass });
});

actions.logout = guard(true, {}, (ret, i, uname) => {
  ret();
  pass.get('tokens')
    .unset(i.token)
    .write();
});

actions.remove = guard(true, {
  id: checks.shortid
}, (ret, i, uname) => {
  let entry = db.get('entries').get(i.id).value();
  if(entry.by != uname)
    return ret(flip('you are not the owner of this entry'));
  if(entry.score > 0)
    return ret(flip('this entry has a positive amount of votes'));
  cache.splice(cache.findIndex(_ => _.id == i.id), 1);
  ret();
  db.get('entries').unset(i.id).write();
  announce({
    color: author_color(uname),
    title: `*${uname}* removed **${entry.head}**`,
    description: entry.body.replace(/___/g, '\u25af')
  });
  db.set('count', db.get('count').value() - 1).write();
});

Object.freeze(actions);

function cacheify(e, id) {
  return {...e, id, _head: deburr(e.head), score: score(e),
      _content: deburr(` ${e.head} ${e.body} ${
        e.notes.map(_ => _.content).join(' ')} `)};
}

function cached(id) {
  return cache.find(_ => _.id == id);
}

db.set('entries',
  db.get('entries')
    .mapValues(_ => {
      if(! _.votes) _.votes = {};
      if(! _.scope) _.scope = 'en';
      if(_.comments) {
        _.notes = _.comments;
        delete _.comments;
      }
      if(_.score != undefined) delete _.score;
      return _;
    }).value()
  ).write();

let now = +new Date;
pass.set('tokens',
  Object.entries(pass.get('tokens').value())
    .map(([k, v]) => {
      if(typeof v == 'string')
        return [k, { name: v,
                     last: +new Date }];
      else if(typeof v == 'object')
        return (now > v.last) ? [k, v] : undefined;
      else return undefined;
    }).filter(_ => _)
  ).write();

cache = Object.entries(db.get('entries').value())
  .map(([id, e]) => cacheify(e, id));
