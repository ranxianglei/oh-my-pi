#!/usr/bin/env bun
/**
 * Publish the fork's sibling packages as @ranxianglei/*@18.0.0, then republish
 * @ranxianglei/omp-stable@18.0.2 wired to them via npm alias dependencies.
 *
 * Why this exists: dist/cli.js externalizes every @oh-my-pi/* import, so an
 * installed tree needs working copies of the 12 sibling packages our source
 * was built against. Upstream never published past 17.4.2 (the v17.4.3/v17.4.4
 * tags were skipped), and our 18.0.0 source uses post-17.4.2 APIs (e.g.
 * pi-natives' HighlightStream), so pinning to upstream releases crashes at
 * runtime. We therefore publish our own builds under the fork scope and keep
 * the original names resolvable via npm alias dependencies:
 *
 *   "@oh-my-pi/pi-utils": "npm:@ranxianglei/pi-utils@18.0.0"
 *
 * Aliases preserve the node_modules layout (@oh-my-pi/<name>), so every
 * runtime resolution path (ESM imports, require.resolve("@oh-my-pi/..."))
 * works unchanged without touching dist/cli.js.
 *
 * Versioning: siblings keep their true workspace version 18.0.0 — NOT bumped —
 * because the prebuilt pi-natives .node bakes in a version sentinel
 * (__piNativesV18_0_0) that the loader validates against the installed
 * package.json version; a mismatched version rejects the addon. omp-stable
 * keeps its own independent line (18.0.2).
 *
 * Steps:
 *   1. Each of the 12 siblings (topological order): rewrite name + alias
 *      internal deps in place, `bun pm pack`, verify the packed manifest,
 *      publish (or stage tarballs in /tmp when dry-running), restore files.
 *      pi-natives additionally excludes raw *.node build artifacts from the
 *      tarball (the addon ships via its embedded archive) and re-runs
 *      gen:native so the embedded addon carries the published identity.
 *   2. Re-run publish-stable.ts --dry-run to produce the resolved omp-stable
 *      tarball, repack it as 18.0.2 with aliased sibling deps, publish.
 *
 * Usage (from packages/coding-agent):
 *   bun scripts/publish-siblings.ts            # dry run: stage tarballs only
 *   bun scripts/publish-siblings.ts --publish  # real npm publishes
 */
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@ranxianglei";
const SIBLING_VERSION = "18.0.0";
const STABLE_VERSION = "18.0.2";
const STABLE_NAME = "@ranxianglei/omp-stable";
// Topological order over the 12 siblings coding-agent depends on.
const SIBLINGS = [
	"omptype",
	"pi-wire",
	"pi-natives",
	"pi-utils",
	"pi-catalog",
	"hashline",
	"pi-ai",
	"omp-stats",
	"snapcompact",
	"pi-agent-core",
	"pi-tui",
	"pi-mnemopi",
];
const INTERNAL_PREFIX = "@oh-my-pi/";
const platformTag = `${process.platform}-${process.arch}`;
const publish = process.argv.includes("--publish");

const here = dirname(fileURLToPath(import.meta.url));
const codingAgentDir = join(here, "..");
const rootDir = join(codingAgentDir, "..", "..");
const dryRunDir = join(tmpdir(), "omp-siblings-dryrun");

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

if (platformTag !== "linux-x64") {
	fail(`This script embeds the linux-x64 native addon; refusing to run on ${platformTag}.`);
}

function findSiblingDir(internalName: string): string {
	for (const entry of readdirSync(join(rootDir, "packages"))) {
		const candidate = join(rootDir, "packages", entry, "package.json");
		if (!existsSync(candidate)) continue;
		if (JSON.parse(readFileSync(candidate, "utf8")).name === internalName) return join(rootDir, "packages", entry);
	}
	fail(`Could not locate workspace directory for ${internalName}`);
}

/** Rewrite every @oh-my-pi/* dep of a sibling to an alias on the fork scope. */
function aliasDeps(pkg: Record<string, unknown>, internalName: string): number {
	let aliased = 0;
	for (const section of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
		const deps = pkg[section] as Record<string, string> | undefined;
		if (!deps) continue;
		for (const key of Object.keys(deps)) {
			if (!key.startsWith(INTERNAL_PREFIX)) continue;
			const base = key.slice(INTERNAL_PREFIX.length);
			if (!SIBLINGS.includes(base)) fail(`${internalName} depends on ${key}, which is not in the publish set.`);
			deps[key] = `npm:${SCOPE}/${base}@${SIBLING_VERSION}`;
			aliased++;
		}
	}
	return aliased;
}

async function packSibling(dir: string, packDir: string): Promise<string> {
	const packed = await $`bun pm pack --quiet --destination ${packDir}`.cwd(dir).quiet().nothrow();
	const output = `${packed.stdout.toString()}${packed.stderr.toString()}`.trim();
	if (packed.exitCode !== 0) fail(`bun pm pack failed in ${dir}:\n${output}`);
	const name = readdirSync(packDir).find(entry => entry.endsWith(".tgz"));
	if (!name) fail(`bun pm pack produced no tarball for ${dir}`);
	return join(packDir, name);
}

async function verifyManifest(tarballPath: string, expectedName: string): Promise<void> {
	const extracted = await $`tar -xOzf ${tarballPath} package/package.json`.quiet().nothrow();
	if (extracted.exitCode !== 0) fail(`Could not read packed manifest from ${tarballPath}`);
	const shipped = JSON.parse(extracted.stdout.toString()) as Record<string, unknown>;
	if (shipped.name !== expectedName || shipped.version !== SIBLING_VERSION) {
		fail(`Packed manifest mismatch: got ${String(shipped.name)}@${String(shipped.version)}, expected ${expectedName}@${SIBLING_VERSION}`);
	}
	for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
		const deps = (shipped[section] ?? {}) as Record<string, string>;
		for (const [dep, spec] of Object.entries(deps)) {
			if (/^(catalog|workspace):/.test(spec)) fail(`Unresolved protocol specifier in ${expectedName}: ${dep} -> ${spec}`);
			if (dep.startsWith(INTERNAL_PREFIX) && !spec.startsWith(`npm:${SCOPE}/`)) {
				fail(`Missing fork-scope alias in ${expectedName}: ${dep} -> ${spec}`);
			}
		}
	}
}

async function publishTarball(tarballPath: string, label: string): Promise<void> {
	if (!publish) {
		mkdirSync(dryRunDir, { recursive: true });
		const outPath = join(dryRunDir, `${label.replace("/", "-")}.tgz`);
		copyFileSync(tarballPath, outPath);
		console.log(`DRY RUN: staged ${label} at ${outPath}`);
		return;
	}
	// Preflight: skip if this version is already published. Registry reads can
	// be stale (404 cached past a fresh publish), so fall through to publish
	// and treat E409 as "already there".
	const preflight = await $`npm view ${label} version`.quiet().nothrow();
	if (preflight.exitCode === 0 && preflight.stdout.toString().trim().length > 0) {
		console.log(`${label} already published; skipping.`);
		return;
	}
	console.log(`Publishing ${label} ...`);
	const result = await $`npm publish ${tarballPath} --access public`.cwd(codingAgentDir).quiet().nothrow();
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	if (output) console.log(output);
	if (result.exitCode !== 0) {
		if (/npm (?:error|err!) code (E409|EPUBLISHCONFLICT)\b|you cannot publish over (?:the )?previously published versions?\b/i.test(output)) {
			console.log(`${label} already published (concurrent or stale preflight); skipping.`);
		} else {
			fail(`npm publish failed for ${label} (exit ${result.exitCode})`);
		}
	} else {
		console.log(`Published ${label}`);
	}
}

console.log(publish ? `PUBLISHING ${SIBLINGS.length + 1} packages to npm` : `DRY RUN: staging ${SIBLINGS.length + 1} tarballs`);

for (const base of SIBLINGS) {
	const internalName = `${INTERNAL_PREFIX}${base}`;
	const publicName = `${SCOPE}/${base}`;
	const dir = findSiblingDir(internalName);
	const pkgPath = join(dir, "package.json");
	const originalPkg = readFileSync(pkgPath, "utf8");
	const nativesDir = join(dir, "native");
	const embeddedPath = join(nativesDir, "embedded-addon.js");
	const hadEmbedded = existsSync(embeddedPath);
	const originalEmbedded = hadEmbedded ? readFileSync(embeddedPath) : null;
	const archivesBefore = hadEmbedded ? readdirSync(nativesDir).filter(e => e.startsWith("embedded-addons.") && e.endsWith(".tar.gz")) : [];
	try {
		const pkg = JSON.parse(originalPkg) as Record<string, unknown>;
		pkg.name = publicName;
		let note = "";
		if (base === "pi-natives") {
			// Ship the addon via the embedded archive only: exclude raw .node
			// build artifacts and dotdirs from the tarball.
			const fileSet = new Set<string>(
				[...((pkg.files as string[]) ?? []).filter(f => f !== "native"), ...archivesBefore.map(e => `native/${e}`)],
			);
			fileSet.add(`native/embedded-addons.${platformTag}.tar.gz`);
			for (const e of readdirSync(nativesDir)) {
				if (!e.startsWith(".") && !e.endsWith(".node")) fileSet.add(`native/${e}`);
			}
			pkg.files = [...fileSet];
			// Re-stamp the embedded addon with the published identity (name +
			// version must match what the loader validates against).
			await $`bun run gen:native`.cwd(dir).quiet();
			note = " [embedded linux-x64 addon]";
		}
		const aliased = aliasDeps(pkg, internalName);
		writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
		const packDir = mkdtempSync(join(tmpdir(), "omp-sib-pack-"));
		try {
			const tarball = await packSibling(dir, packDir);
			await verifyManifest(tarball, publicName);
			console.log(`Packed ${publicName}@${SIBLING_VERSION} (${aliased} aliased deps)${note}`);
			await publishTarball(tarball, `${publicName}@${SIBLING_VERSION}`);
		} finally {
			rmSync(packDir, { recursive: true, force: true });
		}
	} finally {
		writeFileSync(pkgPath, originalPkg);
		if (hadEmbedded && originalEmbedded) writeFileSync(embeddedPath, originalEmbedded);
		if (existsSync(nativesDir)) {
			for (const e of readdirSync(nativesDir).filter(x => x.startsWith("embedded-addons.") && x.endsWith(".tar.gz"))) {
				if (!archivesBefore.includes(e)) rmSync(join(nativesDir, e));
			}
		}
	}
}

// --- omp-stable@STABLE_VERSION on top of the freshly published siblings ----
console.log("Building omp-stable tarball via publish-stable.ts --dry-run ...");
const stableDry = await $`bun scripts/publish-stable.ts --dry-run`.cwd(codingAgentDir).nothrow();
if (stableDry.exitCode !== 0) fail(`publish-stable.ts --dry-run failed:\n${stableDry.stdout}\n${stableDry.stderr}`);
const baseTarball = join(tmpdir(), "@ranxianglei-omp-stable-18.0.1.tgz");
if (!existsSync(baseTarball)) fail(`publish-stable.ts --dry-run did not produce ${baseTarball}`);

const work = mkdtempSync(join(tmpdir(), "omp-stable-repack-"));
try {
	await $`tar -xzf ${baseTarball} -C ${work}`;
	const mPath = join(work, "package/package.json");
	const manifest = JSON.parse(readFileSync(mPath, "utf8")) as Record<string, unknown>;
	manifest.version = STABLE_VERSION;
	let rewired = 0;
	for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
		const deps = manifest[section] as Record<string, string> | undefined;
		if (!deps) continue;
		for (const key of Object.keys(deps)) {
			if (!key.startsWith(INTERNAL_PREFIX)) continue;
			const base = key.slice(INTERNAL_PREFIX.length);
			if (!SIBLINGS.includes(base)) continue;
			deps[key] = `npm:${SCOPE}/${base}@${SIBLING_VERSION}`;
			rewired++;
		}
	}
	if (rewired < 12) fail(`Expected >=12 sibling deps rewired in omp-stable manifest, got ${rewired}`);
	writeFileSync(mPath, JSON.stringify(manifest, null, 2) + "\n");
	const finalTarball = join(work, `ranxianglei-omp-stable-${STABLE_VERSION}.tgz`);
	await $`tar -czf ${finalTarball} -C ${work} package`;
	await verifyStableManifest(finalTarball);
	await publishTarball(finalTarball, `${STABLE_NAME}@${STABLE_VERSION}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}

async function verifyStableManifest(tarballPath: string): Promise<void> {
	const extracted = await $`tar -xOzf ${tarballPath} package/package.json`.quiet().nothrow();
	if (extracted.exitCode !== 0) fail(`Could not read repacked manifest from ${tarballPath}`);
	const shipped = JSON.parse(extracted.stdout.toString()) as Record<string, unknown>;
	if (shipped.name !== STABLE_NAME || shipped.version !== STABLE_VERSION) {
		fail(`Repacked manifest mismatch: got ${String(shipped.name)}@${String(shipped.version)}, expected ${STABLE_NAME}@${STABLE_VERSION}`);
	}
	const deps = (shipped.dependencies ?? {}) as Record<string, string>;
	for (const [dep, spec] of Object.entries(deps)) {
		if (/^(catalog|workspace):/.test(spec)) fail(`Unresolved protocol specifier in repacked manifest: ${dep} -> ${spec}`);
	}
	console.log(`Repacked ${STABLE_NAME}@${STABLE_VERSION} (${Object.keys(deps).length} deps)`);
}

console.log(publish ? "All packages published." : `DRY RUN complete. Tarballs staged in ${dryRunDir}.`);
