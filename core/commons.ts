// commons.ts
// common utilities

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

const old_log = console.log;

export function log(...args: any[]): void {
	const date = new Date()
		.toISOString()
		.replace(/[:-]/g, '')
		.replace('T', '.')
		.substring(4, 15);
	const message = Array.from(args)
		.join(' ')
		// padding the message so that it doesn't interfere
		// with the timestamp column:
		//                '\nMMDD.hhmmss <message>'
		.split('\n')
		.join('\n            ');
	old_log(`${date} ${message}`);
}

export function deburr(s: string): string[] {
	return s
		.normalize('NFD')
		.replace(/\p{M}+|-/gu, '')
		.replace(/[ʼ‘’]/g, "'")
		.split(/(?:(?!['-])\P{L})+/gu)
		.map(_ =>
			_.toLowerCase()
				.replace(/ı/g, 'i')
				.replace(/ȷ/g, 'j')
				.replace(/vy?|w|y/g, 'ꝡ'),
		)
		.filter(_ => _);
}

export enum MatchMode {
	Containing = 0,
	Contained = 1,
	Exact = 2,
}

export function deburrMatch(
	what: string[],
	where: string[],
	mode: MatchMode,
): number {
	const predicate = [
		(a: string, b: string) => b.indexOf(a) !== -1,
		(a: string, b: string) => a.indexOf(b) !== -1,
		(a: string, b: string) => a === b,
	][mode];
	let count = 0;
	for (const w of what) if (where.some(y => predicate(w, y))) count++;
	return count;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(Number.POSITIVE_INFINITY);
const _emitter = emitter;
export { _emitter as emitter };
emitter.emit = function (ev, ...args) {
	// add event name as first arg
	return EventEmitter.prototype.emit.call(this, ev, ev, ...args);
};

function getRepositoryRootPath(): string {
	const { stdout, error } = spawnSync('git worktree list --porcelain', {
		encoding: 'utf8',
		shell: true,
	});
	if (error) {
		throw new Error(
			`Couldn't use git to find repository root path:\n\n${error}`,
		);
	}
	for (const line of stdout.split('\n')) {
		const m = line.match(/^worktree (.+)$/);
		if (m) return m[1];
	}
	throw new Error('Failed to parse git worktree output');
}

/**
 * Figure out the path to the Toadua root (the directory that contains
 * `config`). This tries to call `git worktree` but falls back to parsing
 * `import.meta.url`.
 */
export function getToaduaPath(): string {
	try {
		// Preferably use `git` to figure out where Toadua is rooted...
		return getRepositoryRootPath();
	} catch (e) {
		// but if that fails, fall back to parsing `import.meta.url`:
		console.warn(e);
		const commonsPath = path.dirname(fileURLToPath(import.meta.url));

		// Figure out if we are in `toadua/dist/core` (running `npm build` output)
		// or in `toadua/core` (running TypeScript source code directly).
		return /\bdist\Wcore\b/.test(commonsPath)
			? `${commonsPath}/../..`
			: `${commonsPath}/..`;
	}
}

export interface Note {
	/// An ISO 8601 date string like `2022-12-28T21:38:31.682Z`.
	date: string;
	/// The user who left the note.
	user: string;
	/// The content of the note.
	content: string;
}

export interface Entry {
	/// An entry ID string like `AbCdEfGhI`.
	id: string;
	/// An ISO 8601 date string like `2022-12-28T21:38:31.682Z`.
	date: string;
	/// The Toaq word this entry is for.
	head: string;
	/// The definition of the word.
	body: string;
	/// The name of the user that added the entry.
	user: string;
	/// The scope (`en`, `toa`...) the entry is in.
	scope: string;
	/// Notes left on this entry.
	notes: Note[];
	/// Map from usernames to individual votes.
	votes: Record<string, -1 | 0 | 1>;
	/// Total score of the entry, aggregated from votes.
	score: number;
}

export interface Token {
	/// Username the token is for.
	name: string;
	/// Timestamp the token was created, in milliseconds since the Unix epoch.
	last: number;
}

export interface Db {
	entries: Entry[];
}

export interface Store {
	db?: Db;
	pass?: {
		// Map from usernames to `bcrypt` hashes of their passwords.
		hashes: Record<string, string>;
		// Map from token GUIDs to token objects.
		tokens: Record<string, Token>;
	};
}

export interface ToaduaConfig {
	/**
	 * Currently, this only controls the variant of Vue.js to send to the web
	 * app user.
	 */
	production: boolean;
	/**
	 * The address to display in links, etc. `http://localhost:29138/` by
	 * default; the trailing slash is significant.
	 */
	entry_point: string;
	/**
	 * Port to host the server on. 29138 by default.
	 */
	port: number;
	/**
	 * In bytes. 16384 by default.
	 */
	request_body_size_limit: number;
	/**
	 * In milliseconds. 604_800_000 by default (7 days).
	 */
	token_expiry: number;
	exit_on_module_load_error: boolean;
	/**
	 * Passed to bcrypt.hash. 8 by default. Changing this value will not break
	 * existing passwords.
	 */
	password_rounds: number;

	modules: {
		'modules/disk.js'?: {
			enabled: boolean;
			save_interval: number;
			backup_interval: number;
		};
		'modules/housekeep.js'?: Record<string, never>;
		'modules/update.js'?: { enabled: boolean; update_interval: number };
		'modules/cleanup.js'?: {
			enabled: boolean;
			vote_threshold: number;
			users?: string[];
		};
		'modules/announce.js'?: { enabled: boolean; hook: string };
	};
}

const toaduaPath = getToaduaPath();
const MAIN_CONFIG = `${toaduaPath}/config/config.yml`;
const DEFAULT_CONFIG = `${toaduaPath}/config/defaults.yml`;
// initialise the global config file
const main_config: ToaduaConfig = yaml.load(readFileSync(MAIN_CONFIG));
const default_config: ToaduaConfig = yaml.load(readFileSync(DEFAULT_CONFIG));

export const config: ToaduaConfig = { ...default_config, ...main_config };

// a store for stuff and things
export const store: Store = {};
