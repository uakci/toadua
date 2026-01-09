// server.ts
// the server, duh

console.log('-----------');

import * as fs from 'node:fs';
import * as argparse from 'argparse';
import * as commons from './commons.js';

import { HousekeepModule } from '../modules/housekeep.js';
import { DiskModule } from '../modules/disk.js';
import { UpdateModule } from '../modules/update.js';
import { AnnounceModule } from '../modules/announce.js';

const argparser = new argparse.ArgumentParser({
	description: 'Toaq dictionary',
	add_help: true,
});
argparser.add_argument('-d', '--data-directory', {
	help: 'Directory containing config/ and data/ subdirectories',
	type: 'str',
});
argparser.add_argument('-p', '--port', {
	help: 'Bind port',
	type: 'int',
});
const args = argparser.parse_args();
const installation_dir = commons.getToaduaPath();
const dir = args.data_directory
	? fs.realpathSync(args.data_directory)
	: installation_dir;
process.chdir(dir);

const config = commons.config;

const VERSION = JSON.parse(
	fs.readFileSync(`${installation_dir}/package.json`, 'utf-8'),
).version;
console.log(`starting up v${VERSION}...`);

import * as http from 'node:http';
import * as api from './api.js';
import type { Socket } from 'node:net';
import type { EventEmitter } from 'node:stream';

const fourohfour = static_handler('frontend/404.html', 'text/html', 404);
const routes = {
	'/api': api_handler,
	'/': static_handler('frontend/index.html', 'text/html'),
	'/style.css': static_handler('frontend/style.css', 'text/css'),
	'/FiraSans-Regular-vy.woff2': static_handler(
		'frontend/FiraSans-Regular-vy.woff2',
		'font/woff2',
	),
	'/FiraSans-Bold-vy.woff2': static_handler(
		'frontend/FiraSans-Bold-vy.woff2',
		'font/woff2',
	),
	'/frontend.js': static_handler(
		'frontend/dist/bundle.js',
		'application/javascript',
	),
	'/favicon.png': static_handler('frontend/favicon.png', 'image/png'),
	'/site.webmanifest': static_handler(
		'frontend/site.webmanifest',
		'application/json',
	),
	'/.well-known/assetlinks.json': static_handler(
		'frontend/assetlinks.json',
		'application/json',
	),
};

function api_handler(r, s) {
	const flip = (code, message) => {
		s.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).write(
			message,
		);
		s.end();
	};
	if (r.method === 'POST') {
		let body = '';
		r.on('data', data => {
			body += data;
			if (body.length > config.request_body_size_limit) {
				body = undefined;
				flip(413 /* Payload Too Large */, 'The request was too large.');
				r.connection.destroy();
			}
		});
		r.on('end', async () => {
			let json: unknown;
			try {
				json = JSON.parse(body);
			} catch (e) {
				flip(
					400 /* Bad Request */,
					'The request body could not be parsed as JSON.',
				);
				return;
			}
			try {
				const data = await api.call(json);
				const versioned = { version: VERSION, ...data };
				s.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
				});
				s.end(JSON.stringify(versioned));
			} catch (e) {
				console.log(`unexpected uncaught error: ${e.stack}`);
				flip(
					500 /* Internal Server Error */,
					'Unexpected error while processing request.',
				);
				return;
			}
		});
	} else {
		flip(405 /* Method Not Allowed */, 'Expecting a POST request.');
	}
}

function static_handler(fn: string, mime: string, code = 200) {
	const fname = `${installation_dir}/${fn}`;
	let f = fs.readFileSync(fname);
	const t = fs.statSync(fname).mtimeMs;
	return function static_handler(r, s) {
		const t_ = fs.statSync(fname).mtimeMs;
		if (t_ > t) {
			console.log(
				`file '${fname}' has been reloaded (${f.length}b; mtime ${t_} > ${t})`,
			);
			f = fs.readFileSync(fname);
		}
		s.writeHead(code, {
			'content-type': `${mime}; charset=utf-8`,
		}).write(f);
		s.end();
	};
}

function handler(r, s_) {
	const time = +new Date();
	const url = new URL(r.url, config.entry_point);
	const handler = Object.hasOwn(routes, url.pathname)
		? routes[url.pathname]
		: fourohfour;
	const s = {
		writeHead(code, headers?) {
			if (code !== 200)
				console.log(
					`responding with code ${code} (${http.STATUS_CODES[code]})`,
				);
			s_.writeHead(code, headers);
			return this;
		},
		write(what) {
			const w = what instanceof Buffer ? what : Buffer.from(what);
			console.log(`sent off ${w.length}b`);
			return s_.write(w);
		},
		end(...args) {
			s_.end(...args);
			if (handler !== api_handler)
				console.log(`request handled in ${Date.now() - time} ms`);
		},
	};
	Object.setPrototypeOf(s, s_);
	const { address, port } = r.socket.address();
	console.log(`${r.url} ${address}:${port} -> ${handler.name}`);
	try {
		handler(r, s, url);
	} catch (e) {
		console.log(`error in ${handler.name}: ${e.stack}`);
		try {
			s.writeHead(500 /* Internal Server Error */).end();
		} catch (e) {
			console.log(
				`error while handling error. ignore and eat sock: ${e.stack}`,
			);
		}
	}
}

class ToaduaModules {
	private housekeep?: HousekeepModule;
	private disk?: DiskModule;
	private announce?: AnnounceModule;
	private update?: UpdateModule;

	constructor(
		private store: commons.Store,
		private config: commons.ToaduaConfig,
		private emitter: EventEmitter,
	) {
		const housekeepConfig = config.modules['modules/housekeep.js'];
		if (housekeepConfig) {
			this.housekeep = new HousekeepModule();
		}

		const diskConfig = config.modules['modules/disk.js'];
		if (diskConfig) {
			this.disk = new DiskModule(
				diskConfig.save_interval,
				diskConfig.backup_interval,
			);
		}

		const announceConfig = config.modules['modules/announce.js'];
		if (announceConfig) {
			this.announce = new AnnounceModule(
				announceConfig.enabled,
				announceConfig.hook,
			);
		}

		const updateConfig = config.modules['modules/update.js'];
		if (updateConfig) {
			this.update = new UpdateModule(
				updateConfig.enabled,
				updateConfig.update_interval,
				this.announce,
			);
		}
	}

	public up(): void {
		this.housekeep?.up(this.store, this.config);
		this.disk?.up(this.store);
		this.announce?.up(this.emitter);
		this.update?.up(this.store);
	}

	public down(): void {
		// The other modules don't need to do anything special when Toadua is
		// going down:
		this.disk?.down(this.store);
	}
}

const modules = new ToaduaModules(commons.store, config, commons.emitter);
modules.up();

const server = http.createServer(handler);
const connections: Socket[] = [];

server.on('connection', conn => {
	connections.push(conn);
	conn.on('close', () => {
		connections.splice(connections.indexOf(conn), 0);
	});
});

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'];
for (const s of SIGNALS) process.once(s, bye);

function bye(error) {
	if (error.stack) console.log(`uncaught exception: ${error.stack}`);
	else console.log(`caught signal ${error}`);
	console.log('trying to exit gracefully');
	server.close();
	for (const connection of connections) {
		connection.destroy();
	}
	modules.down();
	process.exit(1);
}

process.on('exit', code => console.log(`exiting with code ${code}`));

const port = Number(args.port ?? config.port ?? 29138);
server.listen(port);
console.log(`server started on :${port}!`);
