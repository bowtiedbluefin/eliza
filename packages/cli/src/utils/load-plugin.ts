import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';

interface PackageJson {
  module?: string;
  main?: string;
}

interface ImportStrategy {
  name: string;
  tryImport: (repository: string) => Promise<any | null>;
}

const DEFAULT_ENTRY_POINT = 'dist/index.js';

/**
 * Get the global node_modules path based on Node.js installation
 */
function getGlobalNodeModulesPath(): string {
  // process.execPath gives us the path to the node executable
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === 'win32') {
    // On Windows, node_modules is typically in the same directory as node.exe
    return path.join(nodeDir, 'node_modules');
  } else {
    // On Unix systems, we go up one level from bin directory
    return path.join(nodeDir, '..', 'lib', 'node_modules');
  }
}

/**
 * Helper function to resolve a path within node_modules
 */
function resolveNodeModulesPath(repository: string, ...segments: string[]): string {
  return path.resolve(process.cwd(), 'node_modules', repository, ...segments);
}

/**
 * Helper function to read and parse package.json
 */
async function readPackageJson(repository: string): Promise<PackageJson | null> {
  const packageJsonPath = resolveNodeModulesPath(repository, 'package.json');
  try {
    if (fs.existsSync(packageJsonPath)) {
      return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    }
  } catch (error) {
    logger.debug(`Failed to read package.json for '${repository}':`, error);
  }
  return null;
}

/**
 * Attempts to import a module from a given path and logs the outcome.
 */
async function tryImporting(
  importPath: string,
  strategy: string,
  repository: string
): Promise<any | null> {
  try {
    const module = await import(importPath);
    logger.success(`Successfully loaded plugin '${repository}' using ${strategy} (${importPath})`);
    return module;
  } catch (error) {
    logger.debug(`Import failed using ${strategy} ('${importPath}'):`, error);
    return null;
  }
}

/**
 * Collection of import strategies
 */
const importStrategies: ImportStrategy[] = [
  {
    name: 'direct path',
    tryImport: async (repository: string) => tryImporting(repository, 'direct path', repository),
  },
  {
    name: 'local node_modules',
    tryImport: async (repository: string) =>
      tryImporting(resolveNodeModulesPath(repository), 'local node_modules', repository),
  },
  // Strategy 2: Node modules with src/index.ts (for TypeScript plugins)
  {
    name: 'TypeScript source',
    tryImport: async (repository: string) => {
      const tsPath = resolveNodeModulesPath(repository, 'src/index.ts');
      if (!fs.existsSync(tsPath)) {
        logger.debug(`TypeScript source not found at ${tsPath} for ${repository}`);
        return null;
      }
      return tryImporting(tsPath, 'TypeScript source', repository);
    },
  },
  {
    name: 'global node_modules',
    tryImport: async (repository: string) => {
      const globalPath = path.resolve(getGlobalNodeModulesPath(), repository);
      if (!fs.existsSync(path.dirname(globalPath))) {
        logger.debug(
          `Global node_modules directory not found at ${path.dirname(globalPath)}, skipping for ${repository}`
        );
        return null;
      }
      return tryImporting(globalPath, 'global node_modules', repository);
    },
  },
  {
    name: 'package.json entry',
    tryImport: async (repository: string) => {
      const packageJson = await readPackageJson(repository);
      if (!packageJson) return null;

      const entryPoint = packageJson.module || packageJson.main || DEFAULT_ENTRY_POINT;
      return tryImporting(
        resolveNodeModulesPath(repository, entryPoint),
        `package.json entry (${entryPoint})`,
        repository
      );
    },
  },
  {
    name: 'common dist pattern',
    tryImport: async (repository: string) => {
      const packageJson = await readPackageJson(repository);
      if (packageJson?.main === DEFAULT_ENTRY_POINT) return null;

      return tryImporting(
        resolveNodeModulesPath(repository, DEFAULT_ENTRY_POINT),
        'common dist pattern',
        repository
      );
    },
  },
  // Strategy 4: Relative path resolution (for monorepo development)
  {
    name: 'relative path',
    tryImport: async (repository: string) => {
      const relativePath = path.resolve('..', repository);
      if (!fs.existsSync(relativePath)) {
        logger.debug(`Relative path not found at ${relativePath} for ${repository}`);
        return null;
      }
      return tryImporting(relativePath, 'relative path', repository);
    },
  },
];

/**
 * Attempts to load a plugin module using various strategies.
 * It tries direct import, local node_modules, TypeScript source, global node_modules,
 * package.json entry points, common dist patterns, and relative paths.
 *
 * @param repository - The plugin repository/package name to load.
 * @returns The loaded plugin module or null if loading fails after all attempts.
 */
export async function loadPluginModule(repository: string): Promise<any | null> {
  logger.debug(`[Plugin Loader] Attempting to load plugin module: ${repository}`);

  let lastError: Error | null = null;

  for (const [index, strategy] of importStrategies.entries()) {
    try {
      logger.debug(`[Plugin Loader] Attempting strategy ${index + 1} (${strategy.name}) for ${repository}`);
      const result = await strategy.tryImport(repository);
      
      if (result) {
        // Handle different export patterns
        const plugin = result.default || 
                     result[`${repository.split('/').pop()}Plugin`] || 
                     result;
        
        if (plugin && typeof plugin === 'object' && plugin.name) {
          logger.info(`[Plugin Loader] Successfully loaded ${repository} using strategy ${index + 1} (${strategy.name})`);
          return result;
        }
      }
    } catch (error) {
      lastError = error as Error;
      logger.debug(`[Plugin Loader] Strategy ${index + 1} (${strategy.name}) failed: ${error.message}`);
      continue;
    }
  }

  // If all strategies failed, provide detailed error
  const errorMessage = `Failed to load plugin '${repository}' after trying all strategies. Last error: ${lastError?.message}`;
  logger.error(`[Plugin Loader] ${errorMessage}`);
  
  // Don't throw - allow other plugins to load
  logger.warn(`[Plugin Loader] Skipping plugin ${repository} - it may not be installed or configured properly`);
  return null;
}
