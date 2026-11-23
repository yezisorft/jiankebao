#!/usr/bin/env node
/**
 * 简课表查看 · 统一静态发布构建脚本（本地打包与 GitHub Pages 工作流共用）
 * 功能：
 * 1. 扫描 src/ 下的全部发布资源（自动排除源码辅助文件与隐藏文件）；
 * 2. 基于所有发布资源路径与字节内容计算确定性 SHA-256 短哈希，生成 CACHE_VERSION 与 CORE_ASSETS；
 * 3. 输出干净的 dist/site/（含更新后的 sw.js），按需同步回 src/sw.js 并生成 dist/jiankebiao-pwa.zip。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE_VERSION = 'v1.0.5';
const EXCLUDED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'sw.js',
  'icons/icon-maskable.svg'
]);

export function collectDeployableFiles(srcDir) {
  const results = [];
  const walk = (dir, relBase = '') => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        if (EXCLUDED_FILES.has(rel) || EXCLUDED_FILES.has(entry.name)) continue;
        results.push({ rel, full });
      }
    }
  };
  walk(srcDir);
  return results;
}

export function computeReleaseMeta(srcDir, baseVersion = BASE_VERSION) {
  const files = collectDeployableFiles(srcDir);
  const hasher = crypto.createHash('sha256');
  for (const f of files) {
    hasher.update(f.rel);
    hasher.update('\0');
    hasher.update(fs.readFileSync(f.full));
    hasher.update('\0');
  }
  const contentHash = hasher.digest('hex').slice(0, 8);
  const cacheVersion = `${baseVersion}-${contentHash}`;
  const coreAssets = ['./', ...files.map((f) => `./${f.rel}`)];
  return { cacheVersion, contentHash, coreAssets, files };
}

export function renderSwWithMeta(swTemplate, cacheVersion, coreAssets) {
  const startMarker = '// @build-meta-start';
  const endMarker = '// @build-meta-end';
  const startIdx = swTemplate.indexOf(startMarker);
  const endIdx = swTemplate.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error('src/sw.js 缺少 @build-meta-start / @build-meta-end 标记，无法注入版本信息。');
  }

  const assetsLines = coreAssets.map((a) => `  '${a}'`).join(',\n');
  const injected = `${startMarker}\nconst CACHE_VERSION = '${cacheVersion}';\nconst CORE_ASSETS = [\n${assetsLines}\n];\n${endMarker}`;
  return swTemplate.slice(0, startIdx) + injected + swTemplate.slice(endIdx + endMarker.length);
}

export function buildRelease(rootDir, options = {}) {
  const {
    syncSrc = false,
    makeZip = true,
    outDir = path.join(rootDir, 'dist', 'site'),
    zipPath = path.join(rootDir, 'dist', 'jiankebiao-pwa.zip'),
    baseVersion = BASE_VERSION
  } = options;

  const srcDir = path.join(rootDir, 'src');
  const swPath = path.join(srcDir, 'sw.js');
  const meta = computeReleaseMeta(srcDir, baseVersion);
  const swSource = fs.readFileSync(swPath, 'utf8');
  const renderedSw = renderSwWithMeta(swSource, meta.cacheVersion, meta.coreAssets);

  if (syncSrc && renderedSw !== swSource) {
    fs.writeFileSync(swPath, renderedSw, 'utf8');
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const f of meta.files) {
    const dest = path.join(outDir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.full, dest);
  }
  fs.writeFileSync(path.join(outDir, 'sw.js'), renderedSw, 'utf8');

  if (makeZip) {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    fs.rmSync(zipPath, { force: true });
    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: outDir });
  }

  return { ...meta, outDir, zipPath: makeZip ? zipPath : null };
}

// CLI 入口
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = new Set(process.argv.slice(2));
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const res = buildRelease(rootDir, {
    syncSrc: args.has('--sync-src'),
    makeZip: !args.has('--no-zip')
  });
  console.log(`✅ 构建完成：${res.cacheVersion}（${res.coreAssets.length} 项预缓存资源）`);
  console.log(`   输出目录：${res.outDir}`);
  if (res.zipPath) console.log(`   发布压缩包：${res.zipPath}`);
}
