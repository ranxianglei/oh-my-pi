#!/usr/bin/env bun
/**
 * Publish this package to npm as @ranxianglei/omp-stable.
 *
 * The internal workspace name stays `@oh-my-pi/pi-coding-agent` because
 * hundreds of internal imports (tests, examples, sibling packages) depend on
 * it; only the published tarball is renamed. This script:
 *
 *   1. Rewrites publish-relevant identity fields in package.json in place
 *      (name, version, bin, description, homepage, repository, bugs,
 *      contributors, publishConfig).
 *   2. Pins sibling dependencies to SIBLING_PIN in BOTH places they resolve
 *      from: the root workspace catalog in package.json AND the frozen
 *      top-level "catalog" block in bun.lock (this is what `bun pm pack`
 *      actually reads). Upstream main bumped these to 18.0.0, which is not
 *      published to npm yet; resolving `catalog:` against it would produce an
 *      uninstallable manifest. Pinning to the last published upstream release
 *      keeps every dependency resolvable. Bump SIBLING_PIN when upstream
 *      publishes 18.0.0.
 *   3. Packs with `bun pm pack` (resolves `catalog:`/`workspace:` protocols
 *      and runs prepack), then publishes the resolved tarball with
 *      `npm publish` — same flow as scripts/ci-release-publish.ts. Plain
 *      `npm publish` would ship `catalog:` specifiers verbatim
 *      (EUNSUPPORTEDPROTOCOL at install time).
 *   4. Restores every modified file verbatim in a finally block.
 *
 * Usage: bun scripts/publish-stable.ts [--dry-run]   (from packages/coding-agent)
 */
import { $ } from "bun";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INTERNAL_NAME = "@oh-my-pi/pi-coding-agent";
const FORK = {
	name: "@ranxianglei/omp-stable",
	homepage: "https://github.com/ranxianglei/oh-my-pi",
	repoUrl: "git+https://github.com/ranxianglei/oh-my-pi.git",
	bugsUrl: "https://github.com/ranxianglei/oh-my-pi/issues",
};
// Fork base is upstream main @18.0.0-dev; 18.0.0 was already published by an
// earlier (broken) run of this script, so the first good version is 18.0.1.
const STABLE_VERSION = "18.0.1";
// Last upstream release published to npm with all sibling packages present.
const SIBLING_PIN = "17.4.2";
const dryRun = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const rootDir = join(pkgDir, "..", "..");
const pkgPath = join(pkgDir, "package.json");
const rootPath = join(rootDir, "package.json");
const lockPath = join(rootDir, "bun.lock");

const originalPkg = readFileSync(pkgPath, "utf8");
const originalRoot = readFileSync(rootPath, "utf8");
const hadLock = existsSync(lockPath);
const originalLock = hadLock ? readFileSync(lockPath, "utf8") : "";
const pkg = JSON.parse(originalPkg) as Record<string, unknown>;
const root = JSON.parse(originalRoot) as Record<string, unknown>;

if (pkg.name !== INTERNAL_NAME) {
	console.error(`Refusing to run: package.json name is ${String(pkg.name)}, expected ${INTERNAL_NAME}.`);
	console.error("A previous publish may have crashed mid-flight; restore package.json and retry.");
	process.exit(1);
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

try {
	// --- 1. Rewrite coding-agent identity -----------------------------------
	pkg.name = FORK.name;
	pkg.version = STABLE_VERSION;
	const description = String(pkg.description ?? "");
	pkg.description = description.includes("(fork") ? description : `${description} (fork with cache_hit_recent status-line segment)`;
	pkg.homepage = FORK.homepage;
	pkg.repository = { type: "git", url: FORK.repoUrl, directory: "packages/coding-agent" };
	pkg.bugs = { url: FORK.bugsUrl };
	const contributors = Array.isArray(pkg.contributors) ? [...(pkg.contributors as string[])] : [];
	if (!contributors.includes("ranxianglei <ranxianglei@gmail.com>")) contributors.push("ranxianglei <ranxianglei@gmail.com>");
	pkg.contributors = contributors;
	pkg.bin = { "omp-stable": "src/cli.ts" };
	pkg.publishConfig = { access: "public" };
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

	// --- 2. Pin sibling catalog entries -------------------------------------
	const workspaces = (root.workspaces ?? {}) as Record<string, unknown>;
	const catalog = (workspaces.catalog ?? root.catalog) as Record<string, string> | undefined;
	if (!catalog) fail("Could not locate workspace catalog in root package.json.");
	let pinned = 0;
	for (const key of Object.keys(catalog)) {
		if (key.startsWith("@oh-my-pi/")) {
			catalog[key] = SIBLING_PIN;
			pinned++;
		}
	}
	console.log(`Pinned ${pinned} @oh-my-pi/* catalog entries to ${SIBLING_PIN}`);
	writeFileSync(rootPath, JSON.stringify(root, null, 2) + "\n");

	// --- 2b. Pin the frozen catalog block in bun.lock ------------------------
	// `bun pm pack` resolves `catalog:` specs from the lockfile's top-level
	// "catalog" block, not from the live root package.json; without this the
	// packed manifest would still reference unpublished sibling versions.
	if (hadLock) {
		const lock = readFileSync(lockPath, "utf8");
		const start = lock.indexOf('\n  "catalog": {');
		if (start === -1) fail('Could not locate "catalog" block in bun.lock.');
		const end = lock.indexOf("\n  },", start);
		if (end === -1) fail('Could not locate end of "catalog" block in bun.lock.');
		let lockPinned = 0;
		const block = lock.slice(start, end).replace(/^(\s*)"(@oh-my-pi\/[^"]+)": "[^"]+",?$/gm, (_m, indent: string, key: string) => {
			lockPinned++;
			return `${indent}"${key}": "${SIBLING_PIN}",`;
		});
		if (lockPinned < 13) fail(`Expected >=13 @oh-my-pi/* entries in bun.lock catalog block, found ${lockPinned}; upstream layout may have changed.`);
		writeFileSync(lockPath, lock.slice(0, start) + block + lock.slice(end));
		console.log(`Pinned ${lockPinned} @oh-my-pi/* entries in bun.lock catalog block to ${SIBLING_PIN}`);
	} else {
		console.log("No bun.lock found; skipping lockfile catalog pin.");
	}

	// --- 3. Pack with bun, publish with npm ----------------------------------
	const packDir = mkdtempSync(join(tmpdir(), "omp-stable-pack-"));
	try {
		const packed = await $`bun pm pack --quiet --destination ${packDir}`.cwd(pkgDir).quiet().nothrow();
		const packOutput = `${packed.stdout.toString()}${packed.stderr.toString()}`.trim();
		if (packed.exitCode !== 0) fail(`bun pm pack failed:\n${packOutput}`);
		const tarballName = readdirSync(packDir).find(entry => entry.endsWith(".tgz"));
		if (!tarballName) fail(`bun pm pack produced no tarball in ${packDir}`);
		const tarballPath = join(packDir, tarballName);

		// Verify the packed manifest is what we intend to ship.
		const extracted = await $`tar -xOzf ${tarballPath} package/package.json`.quiet().nothrow();
		if (extracted.exitCode !== 0) fail(`Could not read packed manifest from ${tarballPath}`);
		const shipped = JSON.parse(extracted.stdout.toString()) as Record<string, unknown>;
		if (shipped.name !== FORK.name || shipped.version !== STABLE_VERSION) {
			fail(`Packed manifest mismatch: got ${String(shipped.name)}@${String(shipped.version)}, expected ${FORK.name}@${STABLE_VERSION}`);
		}
		for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
			const deps = (shipped[section] ?? {}) as Record<string, string>;
			for (const [dep, spec] of Object.entries(deps)) {
				if (/^(catalog|workspace):/.test(spec)) fail(`Unresolved protocol specifier in packed manifest: ${dep} -> ${spec}`);
			}
		}
		console.log(`Packed ${FORK.name}@${STABLE_VERSION} (${tarballName})`);
		if (dryRun) {
			const outPath = join(tmpdir(), `${FORK.name.replace("/", "-")}-${STABLE_VERSION}.tgz`);
			copyFileSync(tarballPath, outPath);
			console.log(`DRY RUN: skipping npm publish. Tarball copied to ${outPath}`);
		} else {
			// Preflight: skip if this version is already published. Registry reads
			// can be stale (404 cached past a fresh publish), so fall through to
			// publish and treat E409 as "already there".
			const preflight = await $`npm view ${`${FORK.name}@${STABLE_VERSION}`} version`.quiet().nothrow();
			const alreadyPublished = preflight.exitCode === 0 && preflight.stdout.toString().trim().length > 0;
			if (alreadyPublished) {
				console.log(`${FORK.name}@${STABLE_VERSION} already published; skipping.`);
			} else {
				console.log(`Publishing ${FORK.name}@${STABLE_VERSION} ...`);
				const result = await $`npm publish ${tarballPath} --access public`.cwd(pkgDir).quiet().nothrow();
				const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
				if (output) console.log(output);
				if (result.exitCode !== 0) {
					if (/npm (?:error|err!) code (E409|EPUBLISHCONFLICT)\b|you cannot publish over (?:the )?previously published versions?\b/i.test(output)) {
						console.log(`${FORK.name}@${STABLE_VERSION} already published (concurrent or stale preflight); skipping.`);
					} else {
						fail(`npm publish failed (exit ${result.exitCode})`);
					}
				} else {
					console.log(`Published ${FORK.name}@${STABLE_VERSION}`);
				}
			}
		}
	} finally {
		rmSync(packDir, { recursive: true, force: true });
	}
} finally {
	writeFileSync(pkgPath, originalPkg);
	writeFileSync(rootPath, originalRoot);
	if (hadLock) writeFileSync(lockPath, originalLock);
}
