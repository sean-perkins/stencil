import type { BuildOptions as ESBuildOptions, BuildResult as ESBuildResult } from 'esbuild';
import * as esbuild from 'esbuild';
import { join } from 'path';

import { BuildOptions } from '../utils/options';

/**
 * Aliases which map the module identifiers we set in `paths` in `tsconfig.json` to
 * bundles (built either with esbuild or with rollup).
 *
 * @returns a map of aliases to bundle entry points, relative to the root directory
 */
export function getEsbuildAliases(): Record<string, string> {
  return {
    // node module redirection
    chalk: 'ansi-colors',

    // mapping aliases to top-level bundle entrypoints
    '@stencil/core/testing': './testing/index.js',
    '@stencil/core/compiler': './compiler/stencil.js',
    '@stencil/core/dev-server': './dev-server/index.js',
    '@stencil/core/mock-doc': './mock-doc/index.cjs',
    '@stencil/core/internal/testing': './internal/testing/index.js',
    '@sys-api-node': './sys/node/index.js',

    // mapping node.js module names to `sys/node` "cache"
    //
    // these allow us to bundle and ship a dependency (like `prompts`) as part
    // of the Stencil distributable but also have our separate bundles
    // reference the same file
    prompts: './sys/node/prompts.js',
    glob: './sys/node/glob.js',
    'graceful-fs': './sys/node/graceful-fs.js',
  };
}

/**
 * Node modules which should be universally marked as external
 *
 * Note that we should not rely on this to mark node.js built-in modules as
 * external. Doing so will override esbuild's automatic marking of those modules
 * as side-effect-free, which allows imports from them to be properly
 * tree-shaken.
 */
const externalNodeModules = [
  '@jest/core',
  '@jest/reporters',
  '@microsoft/typescript-etw',
  'expect',
  'fsevents',
  'jest',
  'jest-cli',
  'jest-config',
  'jest-message-id',
  'jest-pnp-resolver',
  'jest-runner',
  'puppeteer',
  'puppeteer-core',
  'yargs',
];

/**
 * Get a manifest of modules which should be marked as external for a given
 * esbuild bundle
 *
 * @param opts options for the current build
 * @param ownEntryPoint the entry point alias of the current module
 * @returns a list of modules which should be marked as external
 */
export function getEsbuildExternalModules(opts: BuildOptions, ownEntryPoint: string): string[] {
  const bundles = Object.values(opts.output);
  const externalBundles = bundles.filter((outdir) => outdir !== ownEntryPoint).map((outdir) => join(outdir, '*'));

  return [...externalNodeModules, ...externalBundles];
}

/**
 * A helper which runs an array of esbuild, uh, _builds_
 *
 * This accepts an array of build configurations and will either run a synchronous
 * build _or_ run them all in watch mode, depending on the {@link BuildOptions['isWatch']}
 * setting.
 *
 * @param builds the array of outputs to build
 * @param opts Stencil build options
 * @returns a Promise representing the execution of the builds
 */
export function runBuilds(builds: ESBuildOptions[], opts: BuildOptions): Promise<(void | ESBuildResult)[]> {
  if (opts.isWatch) {
    return Promise.all(
      builds.map(async (buildConfig) => {
        const context = await esbuild.context(buildConfig);
        return context.watch();
      }),
    );
  } else {
    return Promise.all(builds.map(esbuild.build));
  }
}

/**
 * Get base esbuild options which we want to always have set for all of our
 * bundles
 *
 * @returns a base set of options
 */
export function getBaseEsbuildOptions(): ESBuildOptions {
  return {
    bundle: true,
    legalComments: 'inline',
    logLevel: 'info',
  };
}
