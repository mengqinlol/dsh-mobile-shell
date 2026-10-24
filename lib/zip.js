/**
 * Minimal streaming ZIP writer (ZIP64-free).
 *
 * The plugin has no dependencies and Node ships no ZIP encoder, so this builds
 * the container by hand: per-entry local headers with data descriptors (sizes
 * unknown while streaming), DEFLATE via node:zlib for ordinary files, STORE for
 * already-compressed or very large ones, then a central directory and EOCD.
 *
 * Limits are deliberate: entries and total bytes are capped so a zip request
 * cannot exhaust memory or disk, and ZIP64 is not implemented - exceeding the
 * caps returns a clear error instead of a corrupt archive.
 */
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { createDeflateRaw } from "node:zlib";

/** Entries and total uncompressed size are capped; classic ZIP has 4 GiB/65535 limits. */
const MAX_ENTRIES = 20000;
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024 * 1024;
/** Above this size a file is stored instead of deflated (CPU, and it is usually media). */
const STORE_ABOVE_BYTES = 64 * 1024 * 1024;

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32Update(crc, chunk) {
	let value = crc;
	for (let index = 0; index < chunk.length; index += 1) value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
	return value >>> 0;
}

function dosDateTime(ms) {
	const date = new Date(ms);
	const year = Math.max(1980, date.getFullYear());
	return {
		time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
		date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
	};
}

function localHeader(entry) {
	const name = Buffer.from(entry.name, "utf8");
	const header = Buffer.alloc(30 + name.length);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(entry.flags, 6);
	header.writeUInt16LE(entry.method, 8);
	header.writeUInt16LE(entry.time, 10);
	header.writeUInt16LE(entry.date, 12);
	header.writeUInt32LE(entry.crc, 14);
	header.writeUInt32LE(entry.compressedSize, 18);
	header.writeUInt32LE(entry.uncompressedSize, 22);
	header.writeUInt16LE(name.length, 26);
	header.writeUInt16LE(0, 28);
	name.copy(header, 30);
	return header;
}

function dataDescriptor(entry) {
	const descriptor = Buffer.alloc(16);
	descriptor.writeUInt32LE(0x08074b50, 0);
	descriptor.writeUInt32LE(entry.crc, 4);
	descriptor.writeUInt32LE(entry.compressedSize, 8);
	descriptor.writeUInt32LE(entry.uncompressedSize, 12);
	return descriptor;
}

function centralHeader(entry) {
	const name = Buffer.from(entry.name, "utf8");
	const header = Buffer.alloc(46 + name.length);
	header.writeUInt32LE(0x02014b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(20, 6);
	header.writeUInt16LE(entry.flags, 8);
	header.writeUInt16LE(entry.method, 10);
	header.writeUInt16LE(entry.time, 12);
	header.writeUInt16LE(entry.date, 14);
	header.writeUInt32LE(entry.crc, 16);
	header.writeUInt32LE(entry.compressedSize, 20);
	header.writeUInt32LE(entry.uncompressedSize, 24);
	header.writeUInt16LE(name.length, 28);
	header.writeUInt16LE(0, 30);
	header.writeUInt16LE(0, 32);
	header.writeUInt16LE(0, 34);
	header.writeUInt16LE(0, 36);
	header.writeUInt32LE(0, 38);
	header.writeUInt32LE(entry.offset, 42);
	name.copy(header, 46);
	return header;
}

/**
 * Walk a directory and collect files (symlinks and special files skipped).
 * @param root - absolute directory to archive.
 * @returns `{ files, totalBytes }` with names relative to root, slash-separated.
 * @throws when the caps are exceeded.
 */
async function collectFiles(root) {
	const files = [];
	let totalBytes = 0;

	async function walk(directory, prefix) {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const full = join(directory, entry.name);
			const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			let info;
			try {
				info = await lstat(full);
			} catch {
				continue;
			}
			if (info.isSymbolicLink()) continue;
			if (info.isDirectory()) {
				await walk(full, name);
				continue;
			}
			if (!info.isFile()) continue;
			totalBytes += info.size;
			if (totalBytes > MAX_TOTAL_BYTES) throw new Error("folder too large to zip (over 3.5 GiB)");
			files.push({ name, path: full, size: info.size, mtimeMs: info.mtimeMs });
			if (files.length > MAX_ENTRIES) throw new Error(`too many files to zip (over ${String(MAX_ENTRIES)})`);
		}
	}

	await walk(root, "");
	return { files, totalBytes };
}

/**
 * Build a ZIP archive from a pre-collected file list as an async iterable of
 * Buffers. Collect first (see collectFiles) so size/entry caps surface as a
 * normal HTTP error instead of a truncated archive.
 * @param files - entries from collectFiles, root-relative slash names.
 * @param [archiveRoot] - optional leading directory name inside the archive.
 */
async function* zipFiles(files, archiveRoot = "") {
	const central = [];
	let offset = 0;

	/** Every byte handed to the caller must advance the offset: the central
	 * directory and each entry's local-header offset depend on it. */
	const track = (buffer) => {
		offset += buffer.length;
		return buffer;
	};

	for (const file of files) {
		const name = archiveRoot === "" ? file.name : `${archiveRoot}/${file.name}`;
		const method = file.size > STORE_ABOVE_BYTES ? METHOD_STORE : METHOD_DEFLATE;
		const { time, date } = dosDateTime(file.mtimeMs);
		const entry = {
			name,
			flags: FLAG_DATA_DESCRIPTOR | FLAG_UTF8,
			method,
			time,
			date,
			crc: 0,
			compressedSize: 0,
			uncompressedSize: 0,
			offset: 0,
		};

		// Open before writing the header, so a file that vanished mid-walk is
		// skipped instead of leaving a corrupt entry.
		const source = createReadStream(file.path);
		const opened = await new Promise((resolve) => {
			source.once("open", () => resolve(true));
			source.once("error", () => resolve(false));
		});
		if (!opened) {
			source.destroy();
			continue;
		}

		entry.offset = offset;
		central.push(entry);
		yield track(localHeader(entry));

		let crc = 0xffffffff;
		const counter = new Transform({
			transform(chunk, _encoding, callback) {
				crc = crc32Update(crc, chunk);
				entry.uncompressedSize += chunk.length;
				callback(null, chunk);
			},
		});

		if (method === METHOD_DEFLATE) {
			const deflate = createDeflateRaw({ level: 6 });
			source.pipe(counter).pipe(deflate);
			for await (const chunk of deflate) {
				entry.compressedSize += chunk.length;
				yield track(chunk);
			}
		} else {
			source.pipe(counter);
			for await (const chunk of counter) {
				entry.compressedSize += chunk.length;
				yield track(chunk);
			}
		}

		entry.crc = (crc ^ 0xffffffff) >>> 0;
		yield track(dataDescriptor(entry));
	}

	const centralOffset = offset;
	for (const entry of central) yield track(centralHeader(entry));
	const centralSize = offset - centralOffset;

	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(central.length, 8);
	end.writeUInt16LE(central.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(centralOffset, 16);
	end.writeUInt16LE(0, 20);
	yield track(end);
}

/** Convenience wrapper: collect, then stream the archive. */
async function* zipDirectory(root, archiveRoot = "") {
	const { files } = await collectFiles(root);
	yield* zipFiles(files, archiveRoot);
}

export { collectFiles, crc32Update, zipDirectory, zipFiles };
