/**
 * Fork identity for user-visible version display.
 *
 * The sibling `@oh-my-pi/*` packages are pinned to the last published upstream
 * release when this package ships as @ranxianglei/omp-stable (see
 * scripts/publish-stable.ts), so the VERSION constant embedded in pi-utils
 * lags behind this package's actual version. Every surface that reports "what
 * version am I running" should use these values instead. When running from
 * source (name still @oh-my-pi/pi-coding-agent) these fall back to upstream
 * behavior: version from this package.json, bin name "omp".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { name: string; version: string };

/** This package's own version (e.g. "18.0.1" once published as @ranxianglei/omp-stable). */
export const FORK_VERSION: string = pkg.version;

/** Binary name shown in --version output, completions, etc. ("omp-stable" when published). */
export const FORK_BIN: string = pkg.name === "@ranxianglei/omp-stable" ? "omp-stable" : "omp";
