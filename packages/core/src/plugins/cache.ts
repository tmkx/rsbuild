import crypto from 'crypto';
import { isAbsolute, join } from 'path';
import { fse } from '@rsbuild/shared';
import {
  findExists,
  isFileExists,
  type Context,
  type BuildCacheOptions,
} from '@rsbuild/shared';
import type { RsbuildPlugin } from '../types';

async function validateCache(
  cacheDirectory: string,
  buildDependencies: Record<string, string[]>,
) {
  const configFile = join(cacheDirectory, 'buildDependencies.json');

  if (await isFileExists(configFile)) {
    const prevBuildDependencies = await fse.readJSON(configFile);

    if (
      JSON.stringify(prevBuildDependencies) ===
      JSON.stringify(buildDependencies)
    ) {
      return;
    }

    /**
     * If the filenames in the buildDependencies are changed, webpack will not invalidate the previous cache.
     * So we need to remove the cache directory to make sure the cache is invalidated.
     */
    await fse.remove(cacheDirectory);
  }

  await fse.outputJSON(configFile, buildDependencies);
}

function getDigestHash(digest: Array<string | undefined>) {
  const fsHash = crypto.createHash('md5');
  const md5 = fsHash.update(JSON.stringify(digest)).digest('hex').slice(0, 8);
  return md5;
}

function getCacheDirectory(
  { cacheDirectory }: BuildCacheOptions,
  context: Context,
) {
  if (cacheDirectory) {
    return isAbsolute(cacheDirectory)
      ? cacheDirectory
      : join(context.rootPath, cacheDirectory);
  }
  return join(context.cachePath, context.bundlerType);
}

/**
 * webpack can't detect the changes of framework config, tsconfig, tailwind config and browserslist config.
 * but they will affect the compilation result, so they need to be added to buildDependencies.
 */
async function getBuildDependencies(context: Readonly<Context>) {
  const rootPackageJson = join(context.rootPath, 'package.json');
  const browserslistConfig = join(context.rootPath, '.browserslistrc');

  const buildDependencies: Record<string, string[]> = {};

  if (await isFileExists(rootPackageJson)) {
    buildDependencies.packageJson = [rootPackageJson];
  }

  if (context.tsconfigPath) {
    buildDependencies.tsconfig = [context.tsconfigPath];
  }

  if (await isFileExists(browserslistConfig)) {
    buildDependencies.browserslistrc = [browserslistConfig];
  }

  const tailwindExts = ['ts', 'js', 'cjs', 'mjs'];
  const configs = tailwindExts.map((ext) =>
    join(context.rootPath, `tailwind.config.${ext}`),
  );
  const tailwindConfig = findExists(configs);

  if (tailwindConfig) {
    buildDependencies.tailwindcss = [tailwindConfig];
  }

  return buildDependencies;
}

export const pluginCache = (): RsbuildPlugin => ({
  name: 'rsbuild:cache',

  setup(api) {
    api.modifyBundlerChain(async (chain, { target, env }) => {
      const { buildCache } = api.getNormalizedConfig().performance;

      if (buildCache === false) {
        chain.cache(false);
        return;
      }

      const { context } = api;
      const cacheConfig = typeof buildCache === 'boolean' ? {} : buildCache;
      const cacheDirectory = getCacheDirectory(cacheConfig, context);
      const buildDependencies = await getBuildDependencies(context);

      await validateCache(cacheDirectory, buildDependencies);

      const useDigest =
        Array.isArray(cacheConfig.cacheDigest) &&
        cacheConfig.cacheDigest.length;

      // @ts-expect-error rspack only support `boolean` but somethings we use webpack provider.
      chain.cache({
        // The default cache name of webpack is '${name}-${env}', and the `name` is `default` by default.
        // We set cache name to avoid cache conflicts of different targets.
        name: useDigest
          ? `${target}-${env}-${getDigestHash(cacheConfig.cacheDigest!)}`
          : `${target}-${env}`,
        type: 'filesystem',
        cacheDirectory,
        buildDependencies,
      });
    });
  },
});
