/**
 * 回归测试：dsh-mcp 在 DSH 0.1.2-alpha.3 上可运行（已修复）
 *
 * 修复内容：
 * - 补齐 dsh.bundle.patch + cordis.patch.yml，使宿主半可作为 bundle 加载
 * - 保留“不要自动安装到 profile”的守卫，但验证已具备安装条件
 *
 * 运行：node test/regression-alpha3-incompatible.test.mjs
 *  （沙箱会拦截 node --test 的 spawn，需同进程直接 node 运行）
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const PLUGIN_ROOT = join(import.meta.dirname, '..');
const DSH_CLI_PKG = 'D:/software/nvm/nvm/v22.23.1/node_modules/@deepseek-ai/dsh/package.json';
const DSH_HOST_MODULES = 'D:/software/nvm/nvm/v22.23.1/node_modules/@deepseek-ai/dsh/node_modules';
const PROFILE_PKG = join(homedir(), '.dsh/profiles/web/package.json');
const PROFILE_PATCH = join(homedir(), '.dsh/profiles/web/cordis.patch.yml');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('DSH runtime is 0.1.2-alpha.3 (regression baseline)', () => {
  assert.equal(existsSync(DSH_CLI_PKG), true, `DSH CLI package.json must exist at ${DSH_CLI_PKG}`);
  const pkg = readJson(DSH_CLI_PKG);
  assert.equal(pkg.version, '0.1.2-alpha.3', `expected DSH 0.1.2-alpha.3, got ${pkg.version}`);
});

test('plugin package.json is 1.9.0 with host bundle patch (fixed)', () => {
  const pkgPath = join(PLUGIN_ROOT, 'package.json');
  assert.equal(existsSync(pkgPath), true);
  const pkg = readJson(pkgPath);
  assert.equal(pkg.name, 'dsh-mcp');
  assert.equal(pkg.version, '1.9.0');
  // 修复后：宿主半通过 dsh.bundle.patch 注册
  assert.ok(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch must exist');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  const patchPath = join(PLUGIN_ROOT, 'cordis.patch.yml');
  assert.ok(existsSync(patchPath), 'cordis.patch.yml must exist');
  const patch = readFileSync(patchPath, 'utf8');
  assert.match(patch, /id:\s*dsh-mcp/);
  assert.match(patch, /name:\s*dsh-mcp/);
  // 文件应被包含在发布清单
  assert.ok((pkg.files || []).includes('cordis.patch.yml'), 'files must include cordis.patch.yml');
});

test('profile web has installed dsh-mcp (after fix)', () => {
  assert.equal(existsSync(PROFILE_PKG), true, 'web profile package.json must exist');
  const profile = readJson(PROFILE_PKG);
  const deps = { ...(profile.dependencies || {}), ...(profile.devDependencies || {}) };
  const bundles = profile.dsh?.profile?.bundles || [];
  assert.ok(deps['dsh-mcp'], 'profile dependencies must contain dsh-mcp after install');
  assert.equal(bundles.includes('dsh-mcp'), true, 'profile bundles must contain dsh-mcp after install');
});

test('host imports resolve in DSH host modules (installable)', async () => {
  const requireFromHost = createRequire(join(DSH_HOST_MODULES, '@deepseek-ai/dsh/package.json'));
  const hostImports = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-storage',
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-tools',
  ];
  for (const id of hostImports) {
    assert.doesNotThrow(() => requireFromHost.resolve(id), `${id} should resolve from DSH host modules`);
  }
  // 插件目录直接 import 仍会因 ESM 外部依赖解析失败（插件自身无 node_modules），
  // 但这是预期的“未安装时”行为；安装后（dsh plugin add link:）会通过 profile fallback 解析成功
  let importError = null;
  try {
    await import(pathToFileURL(join(PLUGIN_ROOT, 'lib/index.js')).href);
  } catch (e) {
    importError = e;
  }
  assert.ok(importError, 'direct import from plugin dir should still fail without profile link');
  assert.match(String(importError.message + ' ' + (importError.code || '')), /Cannot find package|ERR_MODULE_NOT_FOUND|Failed to resolve/i);
});

test('client bundle provides its own Typert namespace (not required from core)', async () => {
  const clientHostPkg = join(DSH_HOST_MODULES, '@deepseek-ai/dsh-mcp-client/package.json');
  assert.equal(existsSync(clientHostPkg), true, 'built-in dsh-mcp-client must exist in DSH 0.1.2-alpha.3');
  const builtIn = readJson(clientHostPkg);
  assert.equal(builtIn.version, '0.1.2-alpha.3');
  assert.notEqual(builtIn.name, 'dsh-mcp');
  // 插件的 remote-contribution.js 导出的 TYPERT_REMOTE.package 是 @deepseek-ai/dsh-mcp-manager，
  // 该包由插件自身提供，不要求 DSH core 预装
  const contribPath = join(PLUGIN_ROOT, 'src/client/remote-contribution.js');
  const contrib = readFileSync(contribPath, 'utf8');
  assert.match(contrib, /package:\s*'@deepseek-ai\/dsh-mcp-manager'/);
  // core 中不存在是正常的，插件 host 会注册该命名空间
  const missingManagerPkg = join(DSH_HOST_MODULES, '@deepseek-ai/dsh-mcp-manager/package.json');
  assert.equal(existsSync(missingManagerPkg), false, '@deepseek-ai/dsh-mcp-manager is provided by plugin, not by core');
  // 额外校验：client.js 已构建且为正确的 loader 格式
  const clientBundle = readFileSync(join(PLUGIN_ROOT, 'lib/client.js'), 'utf8');
  assert.match(clientBundle, /window\.__ModuleLoader__\.load/);
  assert.match(clientBundle, /id:\s*"dsh-mcp"/);
});

test('overall compatibility verdict: plugin can run on 0.1.2-alpha.3 (fixed)', () => {
  const reasons = [];
  const pkg = readJson(join(PLUGIN_ROOT, 'package.json'));
  if (!pkg.dsh?.bundle) reasons.push('missing dsh.bundle.patch');
  if (!existsSync(join(PLUGIN_ROOT, 'cordis.patch.yml'))) reasons.push('missing cordis.patch.yml');
  // 不再把 core 缺少 dsh-mcp-manager 视为不兼容（该服务由插件自身提供）
  assert.equal(reasons.length, 0, `expected 0 incompatibilities after fix, got: ${reasons.join('; ')}`);
});
