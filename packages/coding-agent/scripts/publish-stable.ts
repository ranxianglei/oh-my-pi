#!/usr/bin/env bun
/**
 * Publish this package to npm as @ranxianglei/omp-stable.
 *
 * The internal workspace name stays `@oh-my-pi/pi-coding-agent` because
 * hundreds of internal imports (tests, examples, sibling packages) depend on
 * it; only the published tarball is renamed. This script rewrites the
 * publish-relevant fields in place, runs `npm publish`, and restores the
 * original package.json in a finally block.
 *
 * Usage: bun scripts/publish-stable.ts   (from packages/coding-agent)
 */
import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INTERNAL_NAME = "@oh-my-pi/pi-coding-agent";
const FORK = {
	name: "@ranxianglei/omp-stable",
	homepage: "https://github.com/ranxianglei/oh-my-pi",
	repoUrl: "git+https://github.com/ranxianglei/oh-my-pi.git",
	bugsUrl: "https://github.com/ranxianglei/oh-my-pi/issues",
};

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const pkgPath = join(pkgDir, "package.json");

const original = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(original) as Record<string, unknown>;

if (pkg.name !== INTERNAL_NAME) {
	console.error(`Refusing to run: package.json name is ${String(pkg.name)}, expected ${INTERNAL_NAME}.`);
	console.error("A previous publish may have crashed mid-flight; restore package.json and retry.");
	process.exit(1);
}

try {
	pkg.name = FORK.name;
	pkg.description = `${String(pkg.description ?? "")} (fork with cache_hit_recent status-line segment)`;
	pkg.homepage = FORK.homepage;
	pkg.repository = { type: "git", url: FORK.repoUrl, directory: "packages/coding-agent" };
	pkg.bugs = { url: FORK.bugsUrl };
	const contributors = Array.isArray(pkg.contributors) ? [...pkg.contributors] : [];
	contributors.push("ranxianglei <ranxianglei@gmail.com>");
	pkg.contributors = contributors;
	pkg.bin = { "omp-stable": "src/cli.ts" };
	pkg.publishConfig = { access: "public" };
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

	const version = String(pkg.version);
	console.log(`Publishing ${FORK.name}@${version} ...`);
	await $`npm publish`.cwd(pkgDir);
	console.log(`Published ${FORK.name}@${version}`);
} finally {
	writeFileSync(pkgPath, original);
}
