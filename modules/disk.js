// modules/disk.js
// load from disk, save to disk, do backups

"use strict";
const commons = require('./../core/commons.js')(__filename);
let store = commons.store;
module.exports = {state_change, read, write, using, backup, save};

const http = require('http'),
        fs = require('fs'),
   msgpack = require('what-the-pack').initialize(1 << 22);

function read(fname, deft) {
  let buf;
  try {
    buf = fs.readFileSync(fname);
  } catch(e) {
    console.log(`Note: setting the default value for '${fname
      }' because of a file read failure (${e.code})`);
    write(fname, deft);
    return deft;
  }
  let o;
  try {
    o = JSON.parse(buf.toString());
  } catch(e) {
    o = msgpack.decode(buf);
  }
  console.log(`successfully read ${buf.length}b from '${fname}'`);
  return o;
}

function write_(fname, data, guard_override) {
  let backup = fname + '~',
     encoded = msgpack.encode(data),
    our_size = encoded.length,
     success = false,
    unbackup = true;
  if(!guard_override)
    try {
      let {size: old_size} = fs.statSync(fname);
      if(encoded.length / (old_size || 1) < 0.5) {
        console.log(
          `warning: refusing to destructively write ${our_size
           }b over ${old_size}b file '${fname}'`);
        console.log(`will write to backup '${backup}' only`);
        unbackup = false;
      }
    } catch(e) {
      if(e.code !== 'ENOENT')
        throw e;
    }
  for(let _ = 0; _ < 3; ++_) {
    try {
      fs.writeFileSync(backup, encoded);
    } catch(e) {
      console.log(`error when saving to backup '${backup
        }': ${e.stack}\n`);
      continue;
    }
    success = true;
    break;
  }
  if(!success) {
    console.log(`giving up write to '${fname
      }' after 3 failed attempts\n`);
    return false;
  }
  if(unbackup)
    try {
      fs.renameSync(backup, fname);
    } catch(e) {
      console.log(`error when saving to real '${fname}': ${e.stack}`);
      return false;
    }
  else fname = backup;
  console.log(`successfully wrote ${our_size}b to '${fname}'`);
  return true;
}

var using = {};

function write(fname, data, guard_override) {
  if(using[fname]) console.log(`warning: '${fname
    }' is already being written to`);
  using[fname] = true;
  let res;
  try {
    res = write_(fname, data, guard_override);
  } catch(e) {
    console.log(`unexpected error when handling write to '${fname
                 }: ${e.stack}`);
    res = false;
  }
  delete using[fname];
  return res;
}

function backup() {
  try {
    fs.mkdirSync('backup')
  } catch(e) {
    if(e.code !== 'EEXIST') throw e; 
  } if(!write(`backup/${new Date().toISOString().split(':')[0]
      .replace(/T/, '-')}`, store))
    console.log(`note: backup failed`);
}

function save() {
  return ((a, b) => a && b)(
    write('data/dict.db',     store.db),
    write('data/accounts.db', store.pass));
}

const acts = {save_interval: save, backup_interval: backup};
let first_go = true, intervals = {};
function state_change() {
  for(let k of Object.keys(acts)) {
    if(intervals[k]) commons.clearInterval(intervals[k]);
    if(this && this.enabled && this[k])
      intervals[k] = commons.setInterval(acts[k], this[k]);
  }
  if(first_go) {
    store.db   = read('data/dict.db',     {entries: {},  count: 0 }),
    store.pass = read('data/accounts.db', { hashes: {}, tokens: {}}); 
    first_go = false;
  } else if(!this) {
    console.log(`trying to save data...`);
    save();
  }
}
